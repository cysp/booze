import {
  bottleLocations,
  bottles,
  siteMemberships,
  sites,
  storageLocations,
  wineries,
  wineVintages,
  type BoozeDatabase,
} from "@chikachow/booze-db";
import { and, eq, sql, type SQL } from "drizzle-orm";
import type { SelectedFieldsFlat } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import type { BottleResource } from "../../shared/catalogue-resources.ts";
import { listCriticReviews } from "./critic-reviews.ts";
import { listWineAwards } from "./wine-awards.ts";
import { storedVintageLabel, storedVintageStatus } from "./wine-vintage.ts";

const grapesSchema = z.array(z.string());

export function readGrapeVarieties(value: string): readonly string[] {
  return grapesSchema.parse(JSON.parse(value));
}

// These projections are shared by detail and bounded browse queries. Explicit
// aliases also keep D1 batch result object keys unique across joined tables.
export const wineColumns = {
  siteId: wineVintages.siteId,
  siteName: sql<string>`${sites.name}`.as("site_name"),
  wineryId: wineVintages.wineryId,
  wineryName: sql<string>`coalesce(${wineries.name}, '')`.as("winery_name"),
  brandName: wineVintages.brandName,
  baseName: wineVintages.baseName,
  designation: wineVintages.designation,
  displayName: wineVintages.displayName,
  vintageYear: wineVintages.vintageYear,
  vintageLabel: storedVintageLabel.as("vintage_label"),
  vintageStatus: storedVintageStatus.as("vintage_status"),
  grapeVarieties: sql<string>`coalesce((
      select json_group_array(grape.name order by grape.name)
      from wine_constituents constituent
      join grape_varieties grape on grape.id = constituent.grape_variety_id
      where constituent.site_id = ${wineVintages.siteId}
        and constituent.wine_vintage_id = ${wineVintages.id}
    ), '[]')`.as("grape_varieties"),
  country: wineVintages.country,
  region: wineVintages.region,
  appellation: wineVintages.appellation,
  classification: wineVintages.classification,
  wineType: wineVintages.wineType,
  wineColor: wineVintages.wineColor,
  addressQualification: wineVintages.addressQualification,
  alcoholPercent: wineVintages.alcoholPercent,
  drinkFromYear: wineVintages.drinkFromYear,
  drinkToYear: wineVintages.drinkToYear,
  description: wineVintages.description,
  drinkingAdvice: wineVintages.drinkingAdvice,
  labelText: wineVintages.labelText,
  sourceUrl: wineVintages.sourceUrl,
  wineNotes: sql<string | null>`${wineVintages.notes}`.as("wine_notes"),
};

export const bottleColumns = {
  ...wineColumns,
  id: bottles.id,
  wineVintageId: bottles.wineVintageId,
  wineBottleCount: sql<number>`(
      select count(*) from bottles related
      where related.site_id = ${bottles.siteId}
        and related.wine_vintage_id = ${bottles.wineVintageId}
    )`.as("wine_bottle_count"),
  storageLocationId: sql<string | null>`${bottleLocations.storageLocationId}`.as(
    "storage_location_id",
  ),
  storageLocationName: sql<string | null>`${storageLocations.name}`.as("storage_location_name"),
  positionHint: bottleLocations.positionHint,
  status: bottles.status,
  bottleNumber: bottles.bottleNumber,
  volumeMl: bottles.volumeMl,
  barcode: bottles.barcode,
  lotCode: bottles.lotCode,
  bottleNotes: sql<string | null>`${bottles.notes}`.as("bottle_notes"),
  createdAt: bottles.createdAt,
};

export const bottleSummaryColumns = {
  id: bottleColumns.id,
  wineVintageId: bottleColumns.wineVintageId,
  wineryId: bottleColumns.wineryId,
  wineBottleCount: bottleColumns.wineBottleCount,
  siteId: bottleColumns.siteId,
  siteName: bottleColumns.siteName,
  storageLocationId: bottleColumns.storageLocationId,
  storageLocationName: bottleColumns.storageLocationName,
  positionHint: bottleColumns.positionHint,
  status: bottleColumns.status,
  bottleNumber: bottleColumns.bottleNumber,
  volumeMl: bottleColumns.volumeMl,
  wineryName: bottleColumns.wineryName,
  brandName: bottleColumns.brandName,
  displayName: bottleColumns.displayName,
  vintageYear: bottleColumns.vintageYear,
  vintageStatus: bottleColumns.vintageStatus,
  vintageLabel: bottleColumns.vintageLabel,
  grapeVarieties: bottleColumns.grapeVarieties,
  country: bottleColumns.country,
  region: bottleColumns.region,
  appellation: bottleColumns.appellation,
  alcoholPercent: bottleColumns.alcoholPercent,
  drinkFromYear: bottleColumns.drinkFromYear,
  drinkToYear: bottleColumns.drinkToYear,
  createdAt: bottleColumns.createdAt,
};

// oxlint-disable-next-line typescript/explicit-module-boundary-types -- Preserve the exact generic selection and join types inferred by Drizzle.
export function authorisedBottleQuery<TSelection extends SelectedFieldsFlat>({
  database,
  columns,
  userId,
  where,
}: {
  readonly database: BoozeDatabase;
  readonly columns: TSelection;
  readonly userId: string;
  readonly where?: SQL | undefined;
}) {
  return database
    .select({ resource: columns })
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
    .leftJoin(
      bottleLocations,
      and(eq(bottles.id, bottleLocations.bottleId), eq(bottles.siteId, bottleLocations.siteId)),
    )
    .leftJoin(
      storageLocations,
      and(
        eq(bottleLocations.siteId, storageLocations.siteId),
        eq(bottleLocations.storageLocationId, storageLocations.id),
      ),
    )
    .where(and(eq(siteMemberships.userId, userId), where));
}

// oxlint-disable-next-line typescript/explicit-module-boundary-types -- Preserve the exact generic selection and join types inferred by Drizzle.
export function authorisedWineQuery<TSelection extends SelectedFieldsFlat>({
  database,
  columns,
  userId,
  where,
}: {
  readonly database: BoozeDatabase;
  readonly columns: TSelection;
  readonly userId: string;
  readonly where?: SQL | undefined;
}) {
  return database
    .select({ resource: columns })
    .from(wineVintages)
    .innerJoin(sites, eq(wineVintages.siteId, sites.id))
    .innerJoin(siteMemberships, eq(wineVintages.siteId, siteMemberships.siteId))
    .leftJoin(
      wineries,
      and(eq(wineVintages.siteId, wineries.siteId), eq(wineVintages.wineryId, wineries.id)),
    )
    .where(and(eq(siteMemberships.userId, userId), where));
}

export async function readWineEvidence({
  database,
  userId,
  wineVintageId,
}: {
  readonly database: BoozeDatabase;
  readonly userId: string;
  readonly wineVintageId: string;
}): Promise<Pick<BottleResource, "criticReviews" | "awards">> {
  const [criticReviews, awards] = await Promise.all([
    listCriticReviews({ database, userId, wineVintageId }),
    listWineAwards({ database, userId, wineVintageId }),
  ]);
  return { criticReviews, awards };
}
