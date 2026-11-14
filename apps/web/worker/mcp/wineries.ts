import {
  bottles,
  siteMemberships,
  sites,
  type createD1Client,
  wineries,
  wineVintages,
} from "@chikachow/booze-db";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { decodePageCursor, pageFromRows, pageLimit, type Page } from "./pagination.ts";
import type { listWineriesInputSchema, winerySummarySchema } from "./schemas.ts";
import {
  andAll,
  containsAnyText,
  cursorPredicate,
  sqliteLower,
  optionalContains,
  optionalEquals,
} from "./sql.ts";

const listWineriesToolName = "cellar.list_wineries";
const listWineriesCursorSchema = z.strictObject({
  site: z.string(),
  winery: z.string(),
  wineryId: z.string(),
});

export async function listWineries({
  database,
  input,
  userId,
}: {
  readonly database: ReturnType<typeof createD1Client>;
  readonly input: z.infer<typeof listWineriesInputSchema>;
  readonly userId: string;
}): Promise<Page<z.infer<typeof winerySummarySchema>>> {
  const uniqueWineryBrands = database
    .select({
      siteId: wineVintages.siteId,
      wineryId: wineVintages.wineryId,
      brandName: wineVintages.brandName,
    })
    .from(wineVintages)
    .groupBy(wineVintages.siteId, wineVintages.wineryId, wineVintages.brandName)
    .as("unique_winery_brands");
  const brandNamesByWinery = database
    .select({
      siteId: uniqueWineryBrands.siteId,
      wineryId: uniqueWineryBrands.wineryId,
      brandNames: sql<
        string | null
      >`json_group_array(${uniqueWineryBrands.brandName}) filter (where ${uniqueWineryBrands.brandName} is not null)`.as(
        "brand_names",
      ),
    })
    .from(uniqueWineryBrands)
    .groupBy(uniqueWineryBrands.siteId, uniqueWineryBrands.wineryId)
    .as("brand_names_by_winery");
  const wineVintageCountsByWinery = database
    .select({
      siteId: wineVintages.siteId,
      wineryId: wineVintages.wineryId,
      wineVintageCount: sql<number>`count(${wineVintages.id})`.as("wine_vintage_count"),
    })
    .from(wineVintages)
    .groupBy(wineVintages.siteId, wineVintages.wineryId)
    .as("wine_vintage_counts_by_winery");
  const bottleCountsByWinery = database
    .select({
      siteId: wineVintages.siteId,
      wineryId: wineVintages.wineryId,
      inStockBottleCount: sql<number>`count(${bottles.id})`.as("in_stock_bottle_count"),
    })
    .from(wineVintages)
    .innerJoin(
      bottles,
      and(
        eq(wineVintages.siteId, bottles.siteId),
        eq(wineVintages.id, bottles.wineVintageId),
        eq(bottles.status, "in_stock"),
      ),
    )
    .groupBy(wineVintages.siteId, wineVintages.wineryId)
    .as("bottle_counts_by_winery");
  const siteSort = sql<string>`lower(${sites.name})`;
  const winerySort = sql<string>`lower(${wineries.name})`;
  const cursor = decodePageCursor({
    cursorSchema: listWineriesCursorSchema,
    input,
    toolName: listWineriesToolName,
  });

  const rows = await database
    .select({
      id: wineries.id,
      siteId: wineries.siteId,
      siteName: sites.name,
      wineryName: wineries.name,
      country: wineries.country,
      region: wineries.region,
      brandNames: brandNamesByWinery.brandNames,
      wineVintageCount: sql<number>`coalesce(${wineVintageCountsByWinery.wineVintageCount}, 0)`,
      inStockBottleCount: sql<number>`coalesce(${bottleCountsByWinery.inStockBottleCount}, 0)`,
    })
    .from(wineries)
    .innerJoin(sites, eq(wineries.siteId, sites.id))
    .innerJoin(siteMemberships, eq(wineries.siteId, siteMemberships.siteId))
    .leftJoin(
      brandNamesByWinery,
      and(
        eq(wineries.siteId, brandNamesByWinery.siteId),
        eq(wineries.id, brandNamesByWinery.wineryId),
      ),
    )
    .leftJoin(
      wineVintageCountsByWinery,
      and(
        eq(wineries.siteId, wineVintageCountsByWinery.siteId),
        eq(wineries.id, wineVintageCountsByWinery.wineryId),
      ),
    )
    .leftJoin(
      bottleCountsByWinery,
      and(
        eq(wineries.siteId, bottleCountsByWinery.siteId),
        eq(wineries.id, bottleCountsByWinery.wineryId),
      ),
    )
    .where(
      andAll([
        eq(siteMemberships.userId, userId),
        optionalEquals(wineries.siteId, input.siteId),
        optionalContains(brandNamesByWinery.brandNames, input.brand),
        optionalContains(wineries.region, input.region),
        optionalContains(wineries.country, input.country),
        containsAnyText(input.query, [
          sites.name,
          wineries.name,
          wineries.country,
          wineries.region,
          brandNamesByWinery.brandNames,
        ]),
        cursorPredicate({
          cursor,
          sortKeys: [
            { cursorKey: "site", direction: "asc", expression: siteSort },
            { cursorKey: "winery", direction: "asc", expression: winerySort },
            { cursorKey: "wineryId", direction: "asc", expression: wineries.id },
          ],
        }),
      ]),
    )
    .orderBy(asc(siteSort), asc(winerySort), asc(wineries.id))
    .limit(pageLimit(input));

  const rowPage = pageFromRows({
    cursorForItem: (row) => ({
      site: sqliteLower(row.siteName),
      winery: sqliteLower(row.wineryName),
      wineryId: row.id,
    }),
    input,
    items: rows,
    toolName: listWineriesToolName,
  });

  return {
    items: rowPage.items.map((row) => ({
      brands: row.brandNames === null ? [] : z.array(z.string()).parse(JSON.parse(row.brandNames)),
      country: row.country,
      inStockBottleCount: row.inStockBottleCount ?? 0,
      region: row.region,
      site: row.siteName,
      siteId: row.siteId,
      wineVintageCount: row.wineVintageCount,
      winery: row.wineryName,
      wineryId: row.id,
    })),
    metadata: rowPage.metadata,
  };
}
