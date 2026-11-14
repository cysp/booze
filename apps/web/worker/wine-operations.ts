import { wineVintages } from "@chikachow/booze-db";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import { requireSitePermission } from "./api/auth.ts";
import {
  commitOperation,
  createOperationAudit,
  operationAuditResultSchema,
  type OperationContext,
} from "./operation-transaction.ts";

const drinkingWindowSchema = z
  .strictObject({
    drinkFromYear: z.number().int().min(1800).max(2200).nullable(),
    drinkToYear: z.number().int().min(1800).max(2200).nullable(),
  })
  .refine(
    ({ drinkFromYear, drinkToYear }) =>
      drinkFromYear === null || drinkToYear === null || drinkFromYear <= drinkToYear,
    { message: "drinkFromYear must be less than or equal to drinkToYear" },
  );

const wineWindowSnapshotSchema = z.object({
  id: z.string(),
  siteId: z.string(),
  drinkFromYear: z.number().nullable(),
  drinkToYear: z.number().nullable(),
  bottleCount: z.number().int().min(0),
});

export type WineWindowSnapshot = z.infer<typeof wineWindowSnapshotSchema>;

export async function setDrinkingWindow({
  context,
  wineVintageId,
  drinkFromYear,
  drinkToYear,
}: {
  readonly context: OperationContext;
  readonly wineVintageId: string;
  readonly drinkFromYear: number | null;
  readonly drinkToYear: number | null;
}): Promise<{
  readonly before: WineWindowSnapshot;
  readonly after: WineWindowSnapshot;
  readonly changed: boolean;
  readonly affectedRecordCount: number;
  readonly affectedBottleCount: number;
}> {
  const input = drinkingWindowSchema.parse({ drinkFromYear, drinkToYear });
  const { database, userId } = context;
  // This lookup supplies only the immutable site for permission errors. The
  // operation's values and counts are read inside the committing transaction.
  const rows = await database
    .select({ siteId: wineVintages.siteId })
    .from(wineVintages)
    .where(eq(wineVintages.id, wineVintageId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) throw new HTTPException(404, { message: "Wine vintage not found" });
  const { siteId } = row;
  await requireSitePermission({ database, permission: "site.content.write", siteId, userId });

  const audit = createOperationAudit({
    context,
    siteId,
    action: "cellar.set_drinking_window",
    targetKind: "wine",
    targetId: wineVintageId,
    input: { wineVintageId, ...input },
    before: wineWindowSnapshot(wineVintageId),
    condition: sql`exists (select 1 from wine_vintages where id = ${wineVintageId} and site_id = ${siteId})`,
  });
  const results = await commitOperation(context, siteId, [
    audit.begin,
    database
      .update(wineVintages)
      .set({
        ...input,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(
        and(
          eq(wineVintages.id, wineVintageId),
          eq(wineVintages.siteId, siteId),
          sql`exists (select 1 from mcp_tool_audit_events where id = ${audit.id})`,
          sql`(${wineVintages.drinkFromYear} is not ${input.drinkFromYear}
        or ${wineVintages.drinkToYear} is not ${input.drinkToYear})`,
        ),
      ),
    audit.finish(wineWindowSnapshot(wineVintageId)),
    audit.read,
  ]);
  const event = z.array(operationAuditResultSchema).parse(results.at(-1))[0];
  if (event === undefined) throw new HTTPException(404, { message: "Wine vintage not found" });
  const before = wineWindowSnapshotSchema.parse(JSON.parse(event.beforeJson));
  const after = wineWindowSnapshotSchema.parse(JSON.parse(event.afterJson));
  return {
    before,
    after,
    changed: event.affectedRecordCount !== 0,
    affectedRecordCount: event.affectedRecordCount,
    affectedBottleCount: after.bottleCount,
  };
}

function wineWindowSnapshot(wineVintageId: string): SQL {
  return sql`(select json_object(
    'id', wine.id, 'siteId', wine.site_id,
    'drinkFromYear', wine.drink_from_year, 'drinkToYear', wine.drink_to_year,
    'bottleCount', (select count(*) from bottles where site_id = wine.site_id and wine_vintage_id = wine.id)
  ) from wine_vintages wine where wine.id = ${wineVintageId})`;
}
