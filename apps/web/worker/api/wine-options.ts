import { bottles, wineVintages, type BoozeDatabase } from "@chikachow/booze-db";
import { and, asc, desc, eq, gt, lt, or, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { WineOptionsPage, WineResource } from "../../shared/wine-resources.ts";
import type { WineOptionsQuery } from "./read-query-inputs.ts";
import { pageFromRows, pageLimit, readPaginationCursor } from "../read-pagination.ts";
import {
  authorisedWineQuery,
  readGrapeVarieties,
  readWineEvidence,
  wineColumns,
} from "./catalogue-projections.ts";
import { wineTextSearch } from "./catalogue-search.ts";

const wineOptionsPageName = "http.wine-options";
const wineCursorSchema = z.strictObject({ createdAt: z.string(), id: z.string() });

// Query wines themselves so a wine stays selectable with no remaining bottles.
export async function listWineOptions({
  database,
  input,
  userId,
}: {
  readonly database: BoozeDatabase;
  readonly input: WineOptionsQuery;
  readonly userId: string;
}): Promise<WineOptionsPage> {
  const scopedInput = { ...input, userId };
  const cursor = readPaginationCursor({
    cursorSchema: wineCursorSchema,
    input: scopedInput,
    toolName: wineOptionsPageName,
  });
  const where = and(
    input.siteId === undefined ? undefined : eq(wineVintages.siteId, input.siteId),
    wineTextSearch(input.query),
  );
  const columns = wineColumns;
  const countQuery = authorisedWineQuery({
    database,
    userId,
    where,
    columns: { totalCount: sql<number>`count(*)`.as("total_count") },
  });
  const pageQuery = authorisedWineQuery({
    database,
    userId,
    where: and(
      where,
      cursor === null
        ? undefined
        : or(
            lt(wineVintages.createdAt, cursor.createdAt),
            and(eq(wineVintages.createdAt, cursor.createdAt), gt(wineVintages.id, cursor.id)),
          ),
    ),
    columns: {
      wineVintageId: wineVintages.id,
      siteId: columns.siteId,
      displayName: columns.displayName,
      wineryName: columns.wineryName,
      vintageYear: columns.vintageYear,
      vintageStatus: columns.vintageStatus,
      vintageLabel: columns.vintageLabel,
      region: columns.region,
      grapeVarieties: columns.grapeVarieties,
      createdAt: wineVintages.createdAt,
    },
  })
    .orderBy(desc(wineVintages.createdAt), asc(wineVintages.id))
    .limit(pageLimit(input));
  const [counts, rows] = await database.batch([countQuery, pageQuery]);
  const page = pageFromRows({
    input: scopedInput,
    items: rows.map((row) => row.resource),
    cursorForItem: (row) => ({ createdAt: row.createdAt, id: row.wineVintageId }),
    toolName: wineOptionsPageName,
  });
  return {
    data: page.items.map(({ createdAt: _createdAt, ...row }) => ({
      ...row,
      grapeVarieties: readGrapeVarieties(row.grapeVarieties),
    })),
    totalCount: counts[0]?.resource.totalCount ?? 0,
    nextPageToken: page.metadata.nextPageToken,
  };
}

export async function getWine({
  database,
  userId,
  wineId,
}: {
  readonly database: BoozeDatabase;
  readonly userId: string;
  readonly wineId: string;
}): Promise<WineResource> {
  const [result] = await authorisedWineQuery({
    database,
    userId,
    where: eq(wineVintages.id, wineId),
    columns: {
      ...wineColumns,
      id: wineVintages.id,
      bottleCount:
        sql<number>`(select count(*) from ${bottles} where ${bottles.siteId} = ${wineVintages.siteId} and ${bottles.wineVintageId} = ${wineVintages.id})`.as(
          "bottle_count",
        ),
      inStockBottleCount:
        sql<number>`(select count(*) from ${bottles} where ${bottles.siteId} = ${wineVintages.siteId} and ${bottles.wineVintageId} = ${wineVintages.id} and ${bottles.status} = 'in_stock')`.as(
          "in_stock_bottle_count",
        ),
    },
  }).limit(1);
  const row = result?.resource;
  if (row === undefined) throw new HTTPException(404, { message: "Wine vintage not found" });
  return {
    ...row,
    grapeVarieties: readGrapeVarieties(row.grapeVarieties),
    ...(await readWineEvidence({ database, userId, wineVintageId: wineId })),
  };
}
