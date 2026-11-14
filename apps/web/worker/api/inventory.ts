// oxlint-disable import/max-dependencies -- Inventory reads compose shared contracts, SQL projections, pagination, evidence and catalogue counts.
import {
  bottleLocations,
  bottles,
  siteMemberships,
  storageLocations,
  wineVintages,
  type BoozeDatabase,
} from "@chikachow/booze-db";
import { and, asc, desc, eq, gt, lt, or, sql, type SQL } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { BottleResource } from "../../shared/catalogue-resources.ts";
import {
  calculateDrinkStatus,
  drinkStatuses,
  type DrinkStatus,
} from "../../shared/drink-status.ts";
import type { InventoryPage } from "../../shared/inventory-queries.ts";
import type { CatalogueSummary } from "../../shared/catalogue-summary.ts";
import type { InventoryQuery } from "./read-query-inputs.ts";
import { getCaptureCounts } from "../capture-store.ts";
import { pageFromRows, pageLimit, readPaginationCursor } from "../read-pagination.ts";
import {
  authorisedBottleQuery,
  bottleColumns,
  bottleSummaryColumns,
  readGrapeVarieties,
  readWineEvidence,
} from "./catalogue-projections.ts";
import { bottleTextSearch } from "./catalogue-search.ts";

export type { BottleResource } from "../../shared/catalogue-resources.ts";
export { calculateDrinkStatus } from "../../shared/drink-status.ts";
export type { DrinkStatus } from "../../shared/drink-status.ts";
export type BottleWithDrinkStatus = BottleResource & { readonly drinkStatus: DrinkStatus };

const inventoryPageName = "http.inventory";
const bottleCursorSchema = z.strictObject({ createdAt: z.string(), id: z.string() });

export function drinkStatusExpression(now = new Date()): SQL<string> {
  const currentYear = now.getUTCFullYear();
  return sql<string>`case
    when ${wineVintages.drinkFromYear} is null and ${wineVintages.drinkToYear} is null then 'unknown'
    when ${wineVintages.drinkToYear} is not null and ${currentYear} > ${wineVintages.drinkToYear} then 'past-window'
    when ${wineVintages.drinkFromYear} is not null and ${currentYear} < ${wineVintages.drinkFromYear} then 'hold'
    when ${wineVintages.drinkToYear} is not null and ${wineVintages.drinkToYear} - ${currentYear} <= 2 then 'drink-soon'
    else 'drink-now'
  end`;
}

function inventoryWhere(input: InventoryQuery, now: Date): SQL | undefined {
  const drinkStatus = drinkStatusExpression(now);
  return and(
    input.status === "any" ? undefined : eq(bottles.status, input.status),
    input.siteId === undefined ? undefined : eq(bottles.siteId, input.siteId),
    input.storageLocationId === undefined
      ? undefined
      : eq(bottleLocations.storageLocationId, input.storageLocationId),
    input.grapeVariety === undefined
      ? undefined
      : sql`exists (
      select 1 from wine_constituents constituent
      join grape_varieties grape on grape.id = constituent.grape_variety_id
      where constituent.site_id = ${bottles.siteId} and constituent.wine_vintage_id = ${bottles.wineVintageId}
        and grape.name = ${input.grapeVariety}
    )`,
    input.drinkStatus === undefined ? undefined : eq(drinkStatus, input.drinkStatus),
    input.drinkQueue
      ? sql`${drinkStatus} in ('drink-now', 'drink-soon', 'past-window')`
      : undefined,
    bottleTextSearch(input.query),
  );
}

export async function queryInventory({
  database,
  input,
  userId,
  now = new Date(),
}: {
  readonly database: BoozeDatabase;
  readonly input: InventoryQuery;
  readonly userId: string;
  readonly now?: Date;
}): Promise<InventoryPage> {
  const scopedInput = { ...input, userId, currentYear: now.getUTCFullYear() };
  const cursor = readPaginationCursor({
    cursorSchema: bottleCursorSchema,
    input: scopedInput,
    toolName: inventoryPageName,
  });
  const where = inventoryWhere(input, now);
  const filtered = database.$with("filtered_inventory").as(
    authorisedBottleQuery({
      database,
      columns: {
        id: bottles.id,
        wineVintageId: bottles.wineVintageId,
        siteId: bottles.siteId,
        drinkStatus: drinkStatusExpression(now).as("drink_status"),
      },
      userId,
      where,
    }),
  );
  const countQuery = database
    .with(filtered)
    .select({ totalCount: sql<number>`count(*)`.as("total_count") })
    .from(filtered);
  const pageQuery = authorisedBottleQuery({
    database,
    columns: bottleSummaryColumns,
    userId,
    where: and(
      where,
      cursor === null
        ? undefined
        : or(
            lt(bottles.createdAt, cursor.createdAt),
            and(eq(bottles.createdAt, cursor.createdAt), gt(bottles.id, cursor.id)),
          ),
    ),
  })
    .orderBy(desc(bottles.createdAt), asc(bottles.id))
    .limit(pageLimit(input));
  const grapeQuery = database
    .with(filtered)
    .select({ name: sql<string>`grape.name`.as("grape_name") })
    .from(filtered)
    .innerJoin(
      sql`wine_constituents constituent`,
      sql`constituent.site_id = ${filtered.resource.siteId} and constituent.wine_vintage_id = ${filtered.resource.wineVintageId}`,
    )
    .innerJoin(sql`grape_varieties grape`, sql`grape.id = constituent.grape_variety_id`)
    .groupBy(sql`grape.name`)
    .orderBy(sql`grape.name`);
  const drinkQuery = database
    .with(filtered)
    .select({ drinkStatus: filtered.resource.drinkStatus })
    .from(filtered)
    .groupBy(filtered.resource.drinkStatus);
  const [counts, rows, grapes, statusRows] = await database.batch([
    countQuery,
    pageQuery,
    grapeQuery,
    drinkQuery,
  ]);
  const page = pageFromRows({
    input: scopedInput,
    items: rows.map((row) => row.resource),
    cursorForItem: (row) => ({ createdAt: row.createdAt, id: row.id }),
    toolName: inventoryPageName,
  });
  const presentStatuses = new Set(statusRows.map((row) => row.drinkStatus));
  return {
    data: page.items.map((row) => ({
      ...row,
      grapeVarieties: readGrapeVarieties(row.grapeVarieties),
    })),
    totalCount: counts[0]?.totalCount ?? 0,
    nextPageToken: page.metadata.nextPageToken,
    facets: {
      grapeVarieties: grapes.map((row) => row.name),
      drinkStatuses: drinkStatuses.filter((status) => presentStatuses.has(status)),
    },
  };
}

export async function getBottle({
  bottleId,
  database,
  userId,
}: {
  readonly bottleId: string;
  readonly database: BoozeDatabase;
  readonly userId: string;
}): Promise<BottleResource> {
  const [result] = await authorisedBottleQuery({
    database,
    columns: bottleColumns,
    userId,
    where: eq(bottles.id, bottleId),
  }).limit(1);
  const row = result?.resource;
  if (row === undefined) throw new HTTPException(404, { message: "Bottle not found" });
  return {
    ...row,
    grapeVarieties: readGrapeVarieties(row.grapeVarieties),
    ...(await readWineEvidence({ database, userId, wineVintageId: row.wineVintageId })),
  };
}

export async function getCatalogueSummary({
  database,
  userId,
  now = new Date(),
}: {
  readonly database: BoozeDatabase;
  readonly userId: string;
  readonly now?: Date;
}): Promise<CatalogueSummary> {
  const [counts, captures] = await Promise.all([
    authorisedBottleQuery({
      database,
      userId,
      where: eq(bottles.status, "in_stock"),
      columns: {
        inStockBottleCount: sql<number>`count(*)`,
        drinkQueueBottleCount: sql<number>`coalesce(sum(case when ${drinkStatusExpression(now)} in ('drink-now', 'drink-soon', 'past-window') then 1 else 0 end), 0)`,
      },
    }),
    getCaptureCounts({ database, userId }),
  ]);
  return {
    inStockBottleCount: counts[0]?.resource.inStockBottleCount ?? 0,
    drinkQueueBottleCount: counts[0]?.resource.drinkQueueBottleCount ?? 0,
    captures,
  };
}

export function withDrinkStatus(
  bottle: BottleResource,
  now: Date = new Date(),
): BottleWithDrinkStatus {
  return { ...bottle, drinkStatus: calculateDrinkStatus({ ...bottle, now }) };
}

export async function assertCanReadStorageLocation({
  database,
  storageLocationId,
  userId,
}: {
  readonly database: BoozeDatabase;
  readonly storageLocationId: string;
  readonly userId: string;
}): Promise<void> {
  const rows = await database
    .select({ id: storageLocations.id })
    .from(storageLocations)
    .innerJoin(siteMemberships, eq(storageLocations.siteId, siteMemberships.siteId))
    .where(and(eq(storageLocations.id, storageLocationId), eq(siteMemberships.userId, userId)))
    .limit(1);
  if (rows[0] === undefined)
    throw new HTTPException(404, { message: "Storage location not found" });
}
