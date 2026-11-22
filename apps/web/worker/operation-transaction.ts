import { siteMemberships, type BoozeDatabase } from "@chikachow/booze-db";
import { sql, type SQL } from "drizzle-orm";
import type { BatchResponse } from "drizzle-orm/batch";

import {
  requireSitePermission,
  roleHasSitePermission,
  siteRoleSchema,
  type SitePermission,
} from "./api/auth.ts";

export type OperationContext = {
  readonly database: BoozeDatabase;
  readonly userId: string;
  readonly source: "http" | "mcp";
};

export type OperationStatement = Parameters<BoozeDatabase["batch"]>[0][number];

export function operationPermissionGuard(
  context: OperationContext,
  siteId: string | SQL,
  permission: SitePermission = "site.content.write",
): OperationStatement {
  const allowedRoles = siteRoleSchema.options.filter((role) =>
    roleHasSitePermission(role, permission),
  );
  // SQLite checks NOT NULL before the targeted primary-key conflict. An allowed
  // existing membership is untouched; a missing/revoked membership aborts the
  // whole batch before any catalogue or audit write can commit.
  return context.database
    .insert(siteMemberships)
    .values({
      siteId,
      userId: context.userId,
      role: sql`(select role from site_memberships where site_id = ${siteId}
      and user_id = ${context.userId} and role in (${sql.join(
        allowedRoles.map((role) => sql`${role}`),
        sql`, `,
      )}))`,
    })
    .onConflictDoNothing({ target: [siteMemberships.siteId, siteMemberships.userId] });
}

export async function commitOperation<
  T extends readonly [OperationStatement, ...OperationStatement[]],
>(
  context: OperationContext,
  siteId: string,
  statements: T,
): Promise<BatchResponse<readonly [OperationStatement, ...T]>> {
  try {
    return await context.database.batch([
      operationPermissionGuard(context, siteId),
      ...statements,
    ] as const);
  } catch (error) {
    if (operationConstraintFailed(error, "NOT NULL constraint failed: site_memberships.role")) {
      // Only classify this as permission loss if the current membership proves
      // it. An unrelated trigger with the same constraint message still fails.
      await requireSitePermission({ ...context, siteId, permission: "site.content.write" });
    }
    throw error;
  }
}

export function operationConstraintFailed(error: unknown, constraint: string): boolean {
  const seen = new Set<Error>();
  let cause = error;
  while (cause instanceof Error && !seen.has(cause)) {
    seen.add(cause);
    if (cause.message.includes(constraint)) return true;
    cause = cause.cause;
  }
  return false;
}
