import { mcpToolAuditEvents, siteMemberships, type BoozeDatabase } from "@chikachow/booze-db";
import { eq, sql, type SQL } from "drizzle-orm";
import type { BatchResponse } from "drizzle-orm/batch";
import { z } from "zod";

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

export const operationAuditResultSchema = z.object({
  beforeJson: z.string(),
  afterJson: z.string(),
  affectedRecordCount: z.number().int().min(0),
  targetPersistedId: z.string(),
  siteId: z.string().nullable(),
});

type OperationAudit = {
  readonly id: string;
  readonly begin: OperationStatement;
  readonly finish: (after: SQL, affectedRecordCount?: SQL) => OperationStatement;
  readonly read: OperationStatement;
};

export function createOperationAudit({
  context,
  siteId,
  action,
  targetKind,
  targetId,
  input,
  before,
  condition = sql`1`,
}: {
  readonly context: OperationContext;
  readonly siteId: string | SQL;
  readonly action: string;
  readonly targetKind: "bottle" | "critic_review" | "location" | "review_source" | "wine";
  readonly targetId: string | SQL;
  readonly input: Readonly<Record<string, unknown>>;
  readonly before: SQL;
  readonly condition?: SQL;
}): OperationAudit {
  const { database, userId, source } = context;
  const id = crypto.randomUUID();
  const toolName = source === "mcp" ? action : `http.${action}`;
  return {
    id,
    begin: database.insert(mcpToolAuditEvents)
      .select(sql`select ${id}, ${userId}, ${siteId}, ${toolName}, ${targetKind},
      ${targetId}, ${targetId}, ${JSON.stringify({ ...input, source })}, coalesce(${before}, '{}'), '{}', 0, CURRENT_TIMESTAMP
      where ${condition}`),
    finish(after: SQL, affectedRecordCount?: SQL): OperationStatement {
      const snapshot = sql`coalesce(${after}, '{}')`;
      return database
        .update(mcpToolAuditEvents)
        .set({
          afterJson: snapshot,
          affectedRecordCount:
            affectedRecordCount ??
            sql`case when ${mcpToolAuditEvents.beforeJson} = ${snapshot} then 0 else 1 end`,
        })
        .where(eq(mcpToolAuditEvents.id, id));
    },
    read: database
      .select({
        beforeJson: mcpToolAuditEvents.beforeJson,
        afterJson: mcpToolAuditEvents.afterJson,
        affectedRecordCount: mcpToolAuditEvents.affectedRecordCount,
        targetPersistedId: mcpToolAuditEvents.targetPersistedId,
        siteId: mcpToolAuditEvents.siteId,
      })
      .from(mcpToolAuditEvents)
      .where(eq(mcpToolAuditEvents.id, id))
      .limit(1),
  };
}
