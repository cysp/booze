import {
  bottles,
  siteMemberships,
  sites,
  storageLocations,
  type createD1Client,
} from "@chikachow/booze-db";
import { asc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { decodePageCursor, pageFromRows, pageLimit, type Page } from "../read-pagination.ts";
import type { listSitesInputSchema, siteSummarySchema } from "./schemas.ts";
import { andAll, cursorPredicate, optionalContains, sqliteLower } from "./sql.ts";

export type SiteSummary = z.infer<typeof siteSummarySchema>;

const listSitesToolName = "cellar.list_sites";
const listSitesCursorSchema = z.strictObject({
  site: z.string(),
  siteId: z.string(),
});

export async function listSites({
  database,
  input,
  userId,
}: {
  readonly database: ReturnType<typeof createD1Client>;
  readonly input: z.infer<typeof listSitesInputSchema>;
  readonly userId: string;
}): Promise<Page<z.infer<typeof siteSummarySchema>>> {
  const bottleCountsBySite = bottleCountsBySiteQuery(database);
  const locationCountsBySite = locationCountsBySiteQuery(database);
  const siteSort = sql<string>`lower(${sites.name})`;
  const cursor = decodePageCursor({
    cursorSchema: listSitesCursorSchema,
    input,
    toolName: listSitesToolName,
  });

  const rows = await database
    .select({
      id: sites.id,
      name: sites.name,
      bottleCount: sql<number>`coalesce(${bottleCountsBySite.bottleCount}, 0)`,
      inStockBottleCount: sql<number>`coalesce(${bottleCountsBySite.inStockBottleCount}, 0)`,
      locationCount: sql<number>`coalesce(${locationCountsBySite.locationCount}, 0)`,
    })
    .from(sites)
    .innerJoin(siteMemberships, eq(sites.id, siteMemberships.siteId))
    .leftJoin(bottleCountsBySite, eq(sites.id, bottleCountsBySite.siteId))
    .leftJoin(locationCountsBySite, eq(sites.id, locationCountsBySite.siteId))
    .where(
      andAll([
        eq(siteMemberships.userId, userId),
        optionalContains(sites.name, input.query),
        cursorPredicate({
          cursor,
          sortKeys: [
            { cursorKey: "site", direction: "asc", expression: siteSort },
            { cursorKey: "siteId", direction: "asc", expression: sites.id },
          ],
        }),
      ]),
    )
    .orderBy(asc(siteSort), asc(sites.id))
    .limit(pageLimit(input));

  const siteRows = rows.map((row) => siteSummaryFromRow(row));

  return pageFromRows({
    cursorForItem: (site) => ({ site: sqliteLower(site.site), siteId: site.siteId }),
    input,
    items: siteRows,
    toolName: listSitesToolName,
  });
}

export async function listAuthorisedSiteSummaries({
  database,
  userId,
}: {
  readonly database: ReturnType<typeof createD1Client>;
  readonly userId: string;
}): Promise<SiteSummary[]> {
  const bottleCountsBySite = bottleCountsBySiteQuery(database);
  const locationCountsBySite = locationCountsBySiteQuery(database);

  const rows = await database
    .select({
      id: sites.id,
      name: sites.name,
      bottleCount: sql<number>`coalesce(${bottleCountsBySite.bottleCount}, 0)`,
      inStockBottleCount: sql<number>`coalesce(${bottleCountsBySite.inStockBottleCount}, 0)`,
      locationCount: sql<number>`coalesce(${locationCountsBySite.locationCount}, 0)`,
    })
    .from(sites)
    .innerJoin(siteMemberships, eq(sites.id, siteMemberships.siteId))
    .leftJoin(bottleCountsBySite, eq(sites.id, bottleCountsBySite.siteId))
    .leftJoin(locationCountsBySite, eq(sites.id, locationCountsBySite.siteId))
    .where(eq(siteMemberships.userId, userId))
    .orderBy(asc(sites.name));

  return rows.map((row) => siteSummaryFromRow(row));
}

function bottleCountsBySiteQuery(database: ReturnType<typeof createD1Client>) {
  return database
    .select({
      siteId: bottles.siteId,
      bottleCount: sql<number>`count(${bottles.id})`.as("bottle_count"),
      inStockBottleCount:
        sql<number>`sum(case when ${bottles.status} = 'in_stock' then 1 else 0 end)`.as(
          "in_stock_bottle_count",
        ),
    })
    .from(bottles)
    .groupBy(bottles.siteId)
    .as("bottle_counts_by_site");
}

function locationCountsBySiteQuery(database: ReturnType<typeof createD1Client>) {
  return database
    .select({
      siteId: storageLocations.siteId,
      locationCount: sql<number>`count(${storageLocations.id})`.as("location_count"),
    })
    .from(storageLocations)
    .groupBy(storageLocations.siteId)
    .as("location_counts_by_site");
}

function siteSummaryFromRow(row: {
  readonly bottleCount: number;
  readonly inStockBottleCount: number;
  readonly locationCount: number;
  readonly name: string;
  readonly id: string;
}): SiteSummary {
  return {
    bottleCount: row.bottleCount,
    inStockBottleCount: row.inStockBottleCount,
    locationCount: row.locationCount,
    site: row.name,
    siteId: row.id,
  };
}
