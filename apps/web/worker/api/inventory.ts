import { storedVintageLabel, storedVintageStatus } from "./wine-vintage.ts";
import {
  bottleLocations,
  bottles,
  grapeVarieties,
  siteMemberships,
  sites,
  storageLocations,
  wineConstituents,
  wineries,
  wineVintages,
  type BoozeDatabase,
} from "@chikachow/booze-db";
import { and, desc, eq, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import { listCriticReviews, type CriticReviewResource } from "./critic-reviews.ts";
import { listWineAwards, type WineAwardResource } from "./wine-awards.ts";

export type DrinkStatus = "drink-now" | "drink-soon" | "hold" | "past-window" | "unknown";

import type { BottleResource } from "../../shared/catalogue-resources.ts";
export type { BottleResource } from "../../shared/catalogue-resources.ts";

export type BottleWithDrinkStatus = BottleResource & {
  readonly drinkStatus: DrinkStatus;
};

async function criticReviewsByWineVintage({
  database,
  userId,
}: {
  readonly database: BoozeDatabase;
  readonly userId: string;
}): Promise<ReadonlyMap<string, readonly CriticReviewResource[]>> {
  const reviews = await listCriticReviews({ database, userId });
  const reviewsByWine = new Map<string, CriticReviewResource[]>();
  for (const review of reviews) {
    reviewsByWine.set(review.wineVintageId, [
      ...(reviewsByWine.get(review.wineVintageId) ?? []),
      review,
    ]);
  }
  return reviewsByWine;
}

async function awardsByWineVintage({
  database,
  userId,
}: {
  readonly database: BoozeDatabase;
  readonly userId: string;
}): Promise<ReadonlyMap<string, readonly WineAwardResource[]>> {
  const awards = await listWineAwards({ database, userId });
  const awardsByWine = new Map<string, WineAwardResource[]>();
  for (const award of awards) {
    awardsByWine.set(award.wineVintageId, [
      ...(awardsByWine.get(award.wineVintageId) ?? []),
      award,
    ]);
  }
  return awardsByWine;
}

export async function listBottles({
  database,
  status = "in_stock",
  userId,
}: {
  readonly database: BoozeDatabase;
  readonly status?: "any" | "in_stock";
  readonly userId: string;
}): Promise<readonly BottleResource[]> {
  const grapeVarietiesByWine = database
    .select({
      wineVintageId: wineConstituents.wineVintageId,
      grapeVarieties: sql<
        string | null
      >`json_group_array(${grapeVarieties.name} order by ${grapeVarieties.name})`.as(
        "grape_varieties",
      ),
    })
    .from(wineConstituents)
    .innerJoin(grapeVarieties, eq(wineConstituents.grapeVarietyId, grapeVarieties.id))
    .groupBy(wineConstituents.wineVintageId)
    .as("grape_varieties_by_wine");

  const rows = await database
    .select({
      id: bottles.id,
      wineVintageId: bottles.wineVintageId,
      siteId: bottles.siteId,
      siteName: sites.name,
      storageLocationId: bottleLocations.storageLocationId,
      storageLocationName: storageLocations.name,
      positionHint: bottleLocations.positionHint,
      status: bottles.status,
      bottleNumber: bottles.bottleNumber,
      volumeMl: bottles.volumeMl,
      barcode: bottles.barcode,
      lotCode: bottles.lotCode,
      bottleNotes: bottles.notes,
      wineryId: wineries.id,
      wineryName: wineries.name,
      brandName: wineVintages.brandName,
      baseName: wineVintages.baseName,
      designation: wineVintages.designation,
      displayName: wineVintages.displayName,
      vintageYear: wineVintages.vintageYear,
      vintageLabel: storedVintageLabel,
      vintageStatus: storedVintageStatus,
      wineBottleCount: sql<number>`(select count(*) from bottles as related_bottles where related_bottles.site_id = ${bottles.siteId} and related_bottles.wine_vintage_id = ${bottles.wineVintageId})`,
      grapeVarieties: grapeVarietiesByWine.grapeVarieties,
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
      wineNotes: wineVintages.notes,
      createdAt: bottles.createdAt,
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
      status === "in_stock"
        ? and(eq(siteMemberships.userId, userId), eq(bottles.status, "in_stock"))
        : eq(siteMemberships.userId, userId),
    )
    .orderBy(desc(bottles.createdAt));
  const [criticReviewsByWine, awardsByWine] = await Promise.all([
    criticReviewsByWineVintage({ database, userId }),
    awardsByWineVintage({ database, userId }),
  ]);

  return rows.map((row) => ({
    ...row,
    wineryName: row.wineryName ?? "",
    criticReviews: criticReviewsByWine.get(row.wineVintageId) ?? [],
    awards: awardsByWine.get(row.wineVintageId) ?? [],
    grapeVarieties:
      row.grapeVarieties === null ? [] : z.array(z.string()).parse(JSON.parse(row.grapeVarieties)),
  }));
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
  const bottle = (await listBottles({ database, status: "any", userId })).find(
    (row) => row.id === bottleId,
  );

  if (bottle === undefined) {
    throw new HTTPException(404, { message: "Bottle not found" });
  }
  return bottle;
}

export function calculateDrinkStatus({
  drinkFromYear,
  drinkToYear,
  now = new Date(),
}: {
  readonly drinkFromYear: number | null;
  readonly drinkToYear: number | null;
  readonly now?: Date;
}): DrinkStatus {
  if (drinkFromYear === null && drinkToYear === null) {
    return "unknown";
  }

  const currentYear = now.getUTCFullYear();
  if (drinkToYear !== null && currentYear > drinkToYear) {
    return "past-window";
  }
  if (drinkFromYear !== null && currentYear < drinkFromYear) {
    return "hold";
  }
  if (drinkToYear !== null && drinkToYear - currentYear <= 2) {
    return "drink-soon";
  }
  return "drink-now";
}

export function withDrinkStatus(
  bottle: BottleResource,
  now: Date = new Date(),
): BottleWithDrinkStatus {
  return {
    ...bottle,
    drinkStatus: calculateDrinkStatus({
      drinkFromYear: bottle.drinkFromYear,
      drinkToYear: bottle.drinkToYear,
      now,
    }),
  };
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

  if (rows[0] === undefined) {
    throw new HTTPException(404, { message: "Storage location not found" });
  }
}
