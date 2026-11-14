import { storedVintageLabel, storedVintageStatus } from "../api/wine-vintage.ts";
import {
  bottleLocations,
  bottles,
  grapeVarieties,
  siteMemberships,
  sites,
  storageLocations,
  type createD1Client,
  wineries,
  wineConstituents,
  wineVintages,
} from "@chikachow/booze-db";
import { and, asc, desc, eq, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { z } from "zod";

import type { BottleResource, BottleWithDrinkStatus, DrinkStatus } from "../api/inventory.ts";
import { withDrinkStatus } from "../api/inventory.ts";
import { listStorageLocationDisplayNames } from "./catalogue.ts";
import { decodePageCursor, pageFromRows, pageLimit, type Page } from "./pagination.ts";
import type {
  bottleDetailSchema,
  listDrinkQueueInputSchema,
  locationInventoryInputSchema,
  searchBottlesInputSchema,
} from "./schemas.ts";
import {
  andAll,
  containsAnyText,
  cursorPredicate,
  sqliteLower,
  drinkStatusExpression,
  optionalContains,
  optionalEquals,
  orAll,
} from "./sql.ts";

const searchBottlesToolName = "cellar.search_bottles";
const listDrinkQueueToolName = "cellar.list_drink_queue";
const locationInventoryToolName = "cellar.list_location_bottles";

const bottleCursorSchema = z.strictObject({
  bottleId: z.string(),
  site: z.string(),
  storageLocationId: z.string(),
  vintageSort: z.number(),
  wine: z.string(),
  winery: z.string(),
});

export async function listBottleSummaries({
  database,
  input,
  storageLocationId,
  userId,
}: {
  readonly database: ReturnType<typeof createD1Client>;
  readonly input: z.infer<typeof searchBottlesInputSchema>;
  readonly storageLocationId: string | undefined;
  readonly userId: string;
}): Promise<Page<ReturnType<typeof summarizeBottle>>> {
  return listBottleSummaryRows({
    database,
    input,
    toolName: searchBottlesToolName,
    userId,
    where: ({ grapeVarietyNames }) => [
      optionalEquals(bottles.siteId, input.siteId),
      optionalEquals(bottleLocations.storageLocationId, storageLocationId),
      optionalContains(wineries.name, input.winery),
      optionalContains(wineVintages.region, input.region),
      containsAnyText(input.wine, [
        wineVintages.brandName,
        wineVintages.baseName,
        wineVintages.designation,
        wineVintages.displayName,
      ]),
      optionalContains(grapeVarietyNames, input.grapeVariety),
      optionalEquals(wineVintages.vintageYear, input.vintageYear),
      optionalEquals(drinkStatusExpression(), input.drinkStatus),
      containsAnyText(input.query, [
        sites.name,
        storageLocations.name,
        bottleLocations.positionHint,
        wineries.name,
        wineVintages.brandName,
        wineVintages.baseName,
        wineVintages.designation,
        wineVintages.displayName,
        storedVintageLabel,
        grapeVarietyNames,
        wineVintages.country,
        wineVintages.region,
        wineVintages.appellation,
        wineVintages.classification,
        wineVintages.wineType,
        wineVintages.wineColor,
        bottles.barcode,
        bottles.lotCode,
        wineVintages.labelText,
        wineVintages.notes,
        bottles.notes,
      ]),
    ],
  });
}

export async function listDrinkQueueBottleSummaries({
  database,
  input,
  userId,
}: {
  readonly database: ReturnType<typeof createD1Client>;
  readonly input: z.infer<typeof listDrinkQueueInputSchema>;
  readonly userId: string;
}): Promise<Page<ReturnType<typeof summarizeBottle>>> {
  return listBottleSummaryRows({
    database,
    input,
    toolName: listDrinkQueueToolName,
    userId,
    where: () => [
      orAll(
        input.drinkStatuses.map((drinkStatus) =>
          optionalEquals(drinkStatusExpression(), drinkStatus),
        ),
      ),
    ],
  });
}

export async function listLocationBottleSummaries({
  database,
  input,
  storageLocationId,
  userId,
}: {
  readonly database: ReturnType<typeof createD1Client>;
  readonly input: z.infer<typeof locationInventoryInputSchema>;
  readonly storageLocationId: string;
  readonly userId: string;
}): Promise<Page<ReturnType<typeof summarizeBottle>>> {
  return listBottleSummaryRows({
    database,
    input,
    toolName: locationInventoryToolName,
    userId,
    where: () => [optionalEquals(bottleLocations.storageLocationId, storageLocationId)],
  });
}

type BottleSummaryWhereContext = {
  readonly grapeVarietyNames: SQLWrapper;
};

async function listBottleSummaryRows({
  database,
  input,
  toolName,
  userId,
  where,
}: {
  readonly database: ReturnType<typeof createD1Client>;
  readonly input:
    | z.infer<typeof searchBottlesInputSchema>
    | z.infer<typeof listDrinkQueueInputSchema>
    | z.infer<typeof locationInventoryInputSchema>;
  readonly toolName: string;
  readonly userId: string;
  readonly where: (context: BottleSummaryWhereContext) => readonly (SQL | undefined)[];
}): Promise<Page<ReturnType<typeof summarizeBottle>>> {
  const grapeVarietiesByWine = database
    .select({
      wineVintageId: wineConstituents.wineVintageId,
      grapeVarieties: sql<string | null>`json_group_array(${grapeVarieties.name})`.as(
        "grape_varieties",
      ),
    })
    .from(wineConstituents)
    .innerJoin(grapeVarieties, eq(wineConstituents.grapeVarietyId, grapeVarieties.id))
    .groupBy(wineConstituents.wineVintageId)
    .as("grape_varieties_by_wine");
  const siteSort = sql<string>`lower(${sites.name})`;
  const storageLocationSort = sql<string>`coalesce(${bottleLocations.storageLocationId}, '')`;
  const vintageSort = sql<number>`coalesce(${wineVintages.vintageYear}, -1)`;
  const winerySort = sql<string>`lower(coalesce(${wineries.name}, ''))`;
  const wineSort = sql<string>`lower(${wineVintages.displayName})`;
  const cursor = decodePageCursor({
    cursorSchema: bottleCursorSchema,
    input,
    toolName,
  });

  const rows = await database
    .select({
      addressQualification: wineVintages.addressQualification,
      alcoholPercent: wineVintages.alcoholPercent,
      appellation: wineVintages.appellation,
      barcode: bottles.barcode,
      baseName: wineVintages.baseName,
      bottleNotes: bottles.notes,
      bottleNumber: bottles.bottleNumber,
      brandName: wineVintages.brandName,
      classification: wineVintages.classification,
      country: wineVintages.country,
      createdAt: bottles.createdAt,
      description: wineVintages.description,
      designation: wineVintages.designation,
      displayName: wineVintages.displayName,
      drinkFromYear: wineVintages.drinkFromYear,
      drinkToYear: wineVintages.drinkToYear,
      drinkingAdvice: wineVintages.drinkingAdvice,
      grapeVarieties: grapeVarietiesByWine.grapeVarieties,
      id: bottles.id,
      labelText: wineVintages.labelText,
      lotCode: bottles.lotCode,
      positionHint: bottleLocations.positionHint,
      region: wineVintages.region,
      siteId: bottles.siteId,
      siteName: sites.name,
      sourceUrl: wineVintages.sourceUrl,
      status: bottles.status,
      storageLocationId: bottleLocations.storageLocationId,
      storageLocationName: storageLocations.name,
      vintageLabel: storedVintageLabel,
      vintageStatus: storedVintageStatus,
      wineBottleCount: sql<number>`(select count(*) from bottles as related_bottles where related_bottles.site_id = ${bottles.siteId} and related_bottles.wine_vintage_id = ${bottles.wineVintageId})`,
      vintageYear: wineVintages.vintageYear,
      volumeMl: bottles.volumeMl,
      wineColor: wineVintages.wineColor,
      wineNotes: wineVintages.notes,
      wineType: wineVintages.wineType,
      wineVintageId: bottles.wineVintageId,
      wineryId: wineries.id,
      wineryName: sql<string>`coalesce(${wineries.name}, '')`,
    })
    .from(bottles)
    .innerJoin(sites, eq(bottles.siteId, sites.id))
    .innerJoin(siteMemberships, eq(bottles.siteId, siteMemberships.siteId))
    .innerJoin(
      wineVintages,
      and(eq(bottles.siteId, wineVintages.siteId), eq(bottles.wineVintageId, wineVintages.id)),
    )
    .leftJoin(
      wineries,
      and(eq(wineVintages.siteId, wineries.siteId), eq(wineVintages.wineryId, wineries.id)),
    )
    .leftJoin(bottleLocations, eq(bottles.id, bottleLocations.bottleId))
    .leftJoin(
      storageLocations,
      and(
        eq(bottleLocations.siteId, storageLocations.siteId),
        eq(bottleLocations.storageLocationId, storageLocations.id),
      ),
    )
    .leftJoin(grapeVarietiesByWine, eq(wineVintages.id, grapeVarietiesByWine.wineVintageId))
    .where(
      andAll([
        eq(siteMemberships.userId, userId),
        eq(bottles.status, "in_stock"),
        ...where({ grapeVarietyNames: grapeVarietiesByWine.grapeVarieties }),
        cursorPredicate({
          cursor,
          sortKeys: [
            { cursorKey: "site", direction: "asc", expression: siteSort },
            { cursorKey: "storageLocationId", direction: "asc", expression: storageLocationSort },
            { cursorKey: "vintageSort", direction: "desc", expression: vintageSort },
            { cursorKey: "winery", direction: "asc", expression: winerySort },
            { cursorKey: "wine", direction: "asc", expression: wineSort },
            { cursorKey: "bottleId", direction: "asc", expression: bottles.id },
          ],
        }),
      ]),
    )
    .orderBy(
      asc(siteSort),
      asc(storageLocationSort),
      desc(vintageSort),
      asc(winerySort),
      asc(wineSort),
      asc(bottles.id),
    )
    .limit(pageLimit(input));

  const rowPage = pageFromRows({
    cursorForItem: (row) => ({
      bottleId: row.id,
      site: sqliteLower(row.siteName),
      storageLocationId: row.storageLocationId ?? "",
      vintageSort: row.vintageYear ?? -1,
      wine: sqliteLower(row.displayName),
      winery: sqliteLower(row.wineryName),
    }),
    input,
    items: rows,
    toolName,
  });
  const storageLocationsById = await listStorageLocationDisplayNames({ database, userId });

  return {
    items: rowPage.items.map((row) =>
      summarizeBottle({
        bottle: withDrinkStatus(bottleResourceFromRow(row)),
        storageLocationsById,
      }),
    ),
    metadata: rowPage.metadata,
  };
}

function bottleResourceFromRow(row: {
  readonly addressQualification: string | null;
  readonly alcoholPercent: number | null;
  readonly appellation: string | null;
  readonly barcode: string | null;
  readonly baseName: string;
  readonly bottleNotes: string | null;
  readonly bottleNumber: string | null;
  readonly brandName: string | null;
  readonly classification: string | null;
  readonly country: string | null;
  readonly createdAt: string;
  readonly description: string | null;
  readonly designation: string | null;
  readonly displayName: string;
  readonly drinkFromYear: number | null;
  readonly drinkToYear: number | null;
  readonly drinkingAdvice: string | null;
  readonly grapeVarieties: string | null;
  readonly id: string;
  readonly labelText: string | null;
  readonly lotCode: string | null;
  readonly positionHint: string | null;
  readonly region: string | null;
  readonly siteId: string;
  readonly siteName: string;
  readonly sourceUrl: string | null;
  readonly status: string;
  readonly storageLocationId: string | null;
  readonly storageLocationName: string | null;
  readonly vintageLabel: string;
  readonly vintageStatus: "year" | "non_vintage" | "unknown";
  readonly wineBottleCount: number;
  readonly vintageYear: number | null;
  readonly volumeMl: number;
  readonly wineColor: string | null;
  readonly wineNotes: string | null;
  readonly wineType: string | null;
  readonly wineVintageId: string;
  readonly wineryId: string | null;
  readonly wineryName: string;
}): BottleResource {
  return {
    ...row,
    awards: [],
    criticReviews: [],
    grapeVarieties:
      row.grapeVarieties === null ? [] : z.array(z.string()).parse(JSON.parse(row.grapeVarieties)),
  };
}

export function summarizeBottle({
  bottle,
  storageLocationsById,
}: {
  readonly bottle: BottleWithDrinkStatus;
  readonly storageLocationsById: ReadonlyMap<string, string>;
}): {
  readonly bottleId: string;
  readonly bottleNumber: string | null;
  readonly brand: string | null;
  readonly drinkFromYear: number | null;
  readonly drinkStatus: DrinkStatus;
  readonly drinkToYear: number | null;
  readonly grapeVarieties: readonly string[];
  readonly position: string | null;
  readonly region: string | null;
  readonly site: string;
  readonly siteId: string;
  readonly storageLocation: string | null;
  readonly storageLocationId: string | null;
  readonly vintageLabel: string;
  readonly vintageYear: number | null;
  readonly wine: string;
  readonly wineColor: string | null;
  readonly wineType: string | null;
  readonly wineId: string;
  readonly winery: string;
  readonly wineryId: string | null;
} {
  return {
    bottleId: bottle.id,
    bottleNumber: bottle.bottleNumber,
    brand: bottle.brandName,
    drinkFromYear: bottle.drinkFromYear,
    drinkStatus: bottle.drinkStatus,
    drinkToYear: bottle.drinkToYear,
    grapeVarieties: bottle.grapeVarieties,
    position: bottle.positionHint,
    region: bottle.region,
    site: bottle.siteName,
    siteId: bottle.siteId,
    storageLocation:
      bottle.storageLocationId === null
        ? null
        : (storageLocationsById.get(bottle.storageLocationId) ?? bottle.storageLocationName),
    storageLocationId: bottle.storageLocationId,
    vintageLabel: bottle.vintageLabel,
    vintageYear: bottle.vintageYear,
    wine: bottle.displayName,
    wineColor: bottle.wineColor,
    wineType: bottle.wineType,
    wineId: bottle.wineVintageId,
    winery: bottle.wineryName,
    wineryId: bottle.wineryId,
  };
}

export function bottleDetail({
  bottle,
  storageLocationsById,
}: {
  readonly bottle: BottleWithDrinkStatus;
  readonly storageLocationsById: ReadonlyMap<string, string>;
}): z.infer<typeof bottleDetailSchema> {
  return {
    addressQualification: bottle.addressQualification,
    alcoholPercent: bottle.alcoholPercent,
    appellation: bottle.appellation,
    barcode: bottle.barcode,
    baseName: bottle.baseName,
    bottleId: bottle.id,
    bottleNotes: bottle.bottleNotes,
    bottleNumber: bottle.bottleNumber,
    brand: bottle.brandName,
    classification: bottle.classification,
    country: bottle.country,
    createdAt: bottle.createdAt,
    description: bottle.description,
    designation: bottle.designation,
    drinkFromYear: bottle.drinkFromYear,
    drinkStatus: bottle.drinkStatus,
    drinkToYear: bottle.drinkToYear,
    drinkingAdvice: bottle.drinkingAdvice,
    grapeVarieties: [...bottle.grapeVarieties],
    labelText: bottle.labelText,
    lotCode: bottle.lotCode,
    position: bottle.positionHint,
    region: bottle.region,
    site: bottle.siteName,
    siteId: bottle.siteId,
    sourceUrl: bottle.sourceUrl,
    status: bottle.status,
    storageLocation:
      bottle.storageLocationId === null
        ? null
        : (storageLocationsById.get(bottle.storageLocationId) ?? bottle.storageLocationName),
    storageLocationId: bottle.storageLocationId,
    vintageLabel: bottle.vintageLabel,
    vintageYear: bottle.vintageYear,
    volumeMl: bottle.volumeMl,
    wine: bottle.displayName,
    wineColor: bottle.wineColor,
    wineNotes: bottle.wineNotes,
    wineType: bottle.wineType,
    wineId: bottle.wineVintageId,
    winery: bottle.wineryName,
    wineryId: bottle.wineryId,
  };
}
