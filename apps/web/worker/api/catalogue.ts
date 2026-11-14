import {
  bottles,
  bottleLocations,
  grapeVarieties,
  wineConstituents,
  wineries,
  wineVintages,
  type BoozeDatabase,
} from "@chikachow/booze-db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";

import { generatedId, optionalInteger, optionalText } from "./ids.ts";
import {
  formatWineDisplayName,
  vintageLabel,
  wineVintageStatus,
} from "../../shared/wine-identity.ts";

export type { BottleInput, WineInput } from "../../shared/catalogue-inputs.ts";
import type { BottleInput, WineInput } from "../../shared/catalogue-inputs.ts";

type WineUpdates = { readonly [Key in keyof WineInput]?: WineInput[Key] | undefined };

export type UpsertVintageResult = {
  readonly wineryId: string | null;
  readonly wineVintageId: string;
};

export async function prepareWineVintage({
  database,
  siteId,
  wine,
  overwriteExisting = false,
  updates = wine,
  sourceWineVintageId,
  existingWineVintageId,
}: {
  readonly database: BoozeDatabase;
  readonly siteId: string;
  readonly wine: WineInput;
  readonly overwriteExisting?: boolean;
  readonly updates?: WineUpdates;
  readonly sourceWineVintageId?: string;
  readonly existingWineVintageId?: string;
}): Promise<
  UpsertVintageResult & { readonly statements: [CatalogueStatement, ...CatalogueStatement[]] }
> {
  validateWineInput(wine, updates, overwriteExisting);
  if (existingWineVintageId !== undefined) {
    const existing = await database
      .select({ id: wineVintages.id })
      .from(wineVintages)
      .where(and(eq(wineVintages.siteId, siteId), eq(wineVintages.id, existingWineVintageId)))
      .limit(1);
    if (existing.length === 0)
      throw new HTTPException(404, { message: "Wine not found in this site" });
  }
  const statements: CatalogueStatement[] = [];
  const wineryRegion = optionalText(wine.region);
  const wineryName = optionalText(wine.wineryName);
  const wineryId =
    wineryName === null
      ? null
      : await upsertWinery({
          country: optionalText(wine.country),
          statements,
          database,
          name: wineryName,
          region: wineryRegion,
          siteId,
        });
  const vintage = prepareVintageRow({
    statements,
    database,
    siteId,
    wine,
    wineryId,
    existingWineVintageId,
    updates,
  });
  const wineVintageId = vintage.wineVintageId;

  if (vintage.isNew && sourceWineVintageId !== undefined && sourceWineVintageId !== wineVintageId) {
    // Read source measurements in the same batch as the new wine. Explicit
    // grape edits below retain unchanged rows and give new grapes unknown values.
    statements.push(
      database.insert(wineConstituents).select(sql`
        select site_id, ${wineVintageId}, grape_variety_id, blend_text, percentage,
          created_at, updated_at
        from wine_constituents
        where site_id = ${siteId} and wine_vintage_id = ${sourceWineVintageId}
      `),
    );
  }

  if (
    wine.grapeVarieties !== undefined &&
    (existingWineVintageId === undefined || updates.grapeVarieties !== undefined)
  ) {
    replaceConstituents({
      statements,
      database,
      siteId,
      wineVintageId,
      grapeNames: wine.grapeVarieties,
      replace: overwriteExisting,
    });
  }

  const [first, ...rest] = statements;
  if (first === undefined) throw new Error("Wine upsert requires a statement");
  return { wineryId, wineVintageId, statements: [first, ...rest] };
}

async function upsertWinery({
  statements,
  country,
  database,
  name,
  region,
  siteId,
}: {
  readonly statements: CatalogueStatement[];
  readonly country: string | null;
  readonly database: BoozeDatabase;
  readonly name: string;
  readonly region: string | null;
  readonly siteId: string;
}): Promise<string> {
  const existing = await database
    .select({ id: wineries.id })
    .from(wineries)
    .where(
      and(
        eq(wineries.siteId, siteId),
        eq(wineries.name, name),
        nullableEq(wineries.region, region),
      ),
    )
    .limit(1);
  const wineryId = existing[0]?.id ?? (await wineryIdForIdentity({ siteId, name, region }));

  statements.push(
    database
      .insert(wineries)
      .values({
        id: wineryId,
        siteId,
        name,
        country,
        region,
      })
      .onConflictDoUpdate({
        target: wineries.id,
        set: {
          country: sql`coalesce(${wineries.country}, ${country})`,
          updatedAt: sql`CURRENT_TIMESTAMP`,
        },
      }),
  );

  return wineryId;
}

async function wineryIdForIdentity({
  siteId,
  name,
  region,
}: {
  readonly siteId: string;
  readonly name: string;
  readonly region: string | null;
}): Promise<string> {
  // Current writers share this ID before committing dependent vintages, even
  // when the nullable region bypasses SQLite's natural-key uniqueness check.
  // Existing IDs are reused above. Older writers using random IDs can still
  // create duplicates during an overlapping deployment.
  const identity = new TextEncoder().encode(JSON.stringify([siteId, name, region]));
  const digest = await crypto.subtle.digest("SHA-256", identity);
  return `winery_${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function prepareVintageRow({
  statements,
  database,
  siteId,
  wine,
  wineryId,
  existingWineVintageId,
  updates,
}: {
  readonly statements: CatalogueStatement[];
  readonly database: BoozeDatabase;
  readonly siteId: string;
  readonly wine: WineInput;
  readonly wineryId: string | null;
  readonly existingWineVintageId: string | undefined;
  readonly updates: WineUpdates;
}): { readonly wineVintageId: string; readonly isNew: boolean } {
  const wineVintageId = existingWineVintageId ?? generatedId("vintage");
  const values = {
    wineryId,
    brandName: optionalText(wine.brandName),
    baseName:
      optionalText(wine.baseName) ?? optionalText(wine.designation) ?? formatWineDisplayName(wine),
    displayName: optionalText(wine.displayName) ?? formatWineDisplayName(wine),
    designation: optionalText(wine.designation),
    vintageYear: optionalInteger(wine.vintageYear),
    vintageStatus: wineVintageStatus(wine),
    vintageLabel: vintageLabel(wine),
    wineType: optionalText(wine.wineType),
    wineColor: optionalText(wine.wineColor),
    country: optionalText(wine.country),
    region: optionalText(wine.region),
    appellation: optionalText(wine.appellation),
    classification: optionalText(wine.classification),
    addressQualification: optionalText(wine.addressQualification),
    alcoholPercent: wine.alcoholPercent ?? null,
    drinkFromYear: optionalInteger(wine.drinkFromYear),
    drinkToYear: optionalInteger(wine.drinkToYear),
    description: optionalText(wine.description),
    drinkingAdvice: optionalText(wine.drinkingAdvice),
    labelText: optionalText(wine.labelText),
    sourceUrl: optionalText(wine.sourceUrl),
    notes: optionalText(wine.notes),
  };
  const editsIdentity = [
    "wineryName",
    "brandName",
    "designation",
    "grapeVarieties",
    "appellation",
  ].some((key) => Object.hasOwn(updates, key));
  const editsVintage = updates.vintageYear !== undefined || updates.vintageStatus !== undefined;
  const changes = {
    wineryId:
      updates.wineryName !== undefined || updates.region !== undefined
        ? values.wineryId
        : undefined,
    displayName:
      editsIdentity || updates.displayName !== undefined ? values.displayName : undefined,
    vintageYear: editsVintage ? values.vintageYear : undefined,
    vintageStatus: editsVintage ? values.vintageStatus : undefined,
    vintageLabel: editsVintage ? values.vintageLabel : undefined,
    brandName: whenDefined(updates.brandName, values.brandName),
    baseName:
      updates.designation === undefined
        ? whenDefined(updates.baseName, values.baseName)
        : values.baseName,
    designation: whenDefined(updates.designation, values.designation),
    wineType: whenDefined(updates.wineType, values.wineType),
    wineColor: whenDefined(updates.wineColor, values.wineColor),
    country: whenDefined(updates.country, values.country),
    region: whenDefined(updates.region, values.region),
    appellation: whenDefined(updates.appellation, values.appellation),
    classification: whenDefined(updates.classification, values.classification),
    addressQualification: whenDefined(updates.addressQualification, values.addressQualification),
    alcoholPercent: whenDefined(updates.alcoholPercent, values.alcoholPercent),
    drinkFromYear: whenDefined(updates.drinkFromYear, values.drinkFromYear),
    drinkToYear: whenDefined(updates.drinkToYear, values.drinkToYear),
    description: whenDefined(updates.description, values.description),
    drinkingAdvice: whenDefined(updates.drinkingAdvice, values.drinkingAdvice),
    labelText: whenDefined(updates.labelText, values.labelText),
    sourceUrl: whenDefined(updates.sourceUrl, values.sourceUrl),
    notes: whenDefined(updates.notes, values.notes),
    updatedAt: sql`CURRENT_TIMESTAMP`,
  };
  statements.push(
    existingWineVintageId === undefined
      ? database.insert(wineVintages).values({ id: wineVintageId, siteId, ...values })
      : database
          .update(wineVintages)
          .set(changes)
          .where(and(eq(wineVintages.siteId, siteId), eq(wineVintages.id, wineVintageId))),
  );
  return { wineVintageId, isNew: existingWineVintageId === undefined };
}

export type BottleCreationInput = {
  readonly bottleIds?: readonly string[] | undefined;
  readonly database: BoozeDatabase;
  readonly siteId: string;
  readonly wineVintageId: string;
  readonly storageLocationId: string | null;
  readonly positionHint: string | null;
  readonly bottle: BottleInput;
  readonly quantity: number;
};

type CatalogueStatement = Parameters<BoozeDatabase["batch"]>[0][number];

export function createBottleStatements({
  bottleIds,
  database,
  siteId,
  wineVintageId,
  storageLocationId,
  positionHint,
  bottle,
  quantity,
}: BottleCreationInput): {
  readonly bottleIds: readonly string[];
  readonly statements: [CatalogueStatement, ...CatalogueStatement[]];
} {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 24) {
    throw new Error("Bottle quantity must be between 1 and 24");
  }
  if (bottleIds !== undefined && bottleIds.length !== quantity) {
    throw new Error("Bottle IDs must match quantity");
  }
  const ids = Array.from(
    { length: quantity },
    (_, index) => bottleIds?.[index] ?? crypto.randomUUID(),
  );
  const statements: CatalogueStatement[] = [];
  for (const id of ids) {
    statements.push(
      database
        .insert(bottles)
        .values({
          id,
          siteId,
          wineVintageId,
          bottleNumber: optionalText(bottle.bottleNumber),
          volumeMl: bottle.volumeMl ?? 750,
          barcode: optionalText(bottle.barcode),
          lotCode: optionalText(bottle.lotCode),
          status: "in_stock",
          notes: optionalText(bottle.notes),
        })
        .onConflictDoNothing({ target: bottles.id }),
    );
    if (storageLocationId !== null) {
      statements.push(
        database
          .insert(bottleLocations)
          .values({
            bottleId: id,
            siteId,
            storageLocationId,
            positionHint,
          })
          .onConflictDoNothing({ target: bottleLocations.bottleId }),
      );
    }
  }
  const [first, ...rest] = statements;
  if (first === undefined) {
    throw new Error("Bottle creation requires a statement");
  }
  return { bottleIds: ids, statements: [first, ...rest] };
}

function nullableEq(column: typeof wineries.region, value: string | null) {
  return value === null ? isNull(column) : eq(column, value);
}

function replaceConstituents({
  statements,
  database,
  siteId,
  wineVintageId,
  grapeNames,
  replace,
}: {
  readonly statements: CatalogueStatement[];
  readonly database: BoozeDatabase;
  readonly siteId: string;
  readonly wineVintageId: string;
  readonly grapeNames: readonly string[];
  readonly replace: boolean;
}): void {
  const uniqueNames = [
    ...new Set(grapeNames.map((name) => name.trim()).filter((name) => name !== "")),
  ];
  if (replace) {
    statements.push(
      database.delete(wineConstituents).where(
        and(
          eq(wineConstituents.siteId, siteId),
          eq(wineConstituents.wineVintageId, wineVintageId),
          sql`${wineConstituents.grapeVarietyId} not in (
              select ${grapeVarieties.id} from ${grapeVarieties}
              where ${grapeVarieties.name} in (select value from json_each(${JSON.stringify(uniqueNames)}))
            )`,
        ),
      ),
    );
  }
  for (const grapeName of uniqueNames) {
    statements.push(
      database
        .insert(grapeVarieties)
        .values({ id: generatedId("grape"), name: grapeName })
        .onConflictDoNothing({ target: grapeVarieties.name }),
      database
        .insert(wineConstituents)
        .values({
          siteId,
          wineVintageId,
          grapeVarietyId: sql`(select id from grape_varieties where name = ${grapeName})`,
          blendText: null,
          percentage: null,
        })
        .onConflictDoNothing({
          target: [wineConstituents.wineVintageId, wineConstituents.grapeVarietyId],
        }),
    );
  }
}

function validateWineInput(wine: WineInput, updates: WineUpdates, overwriteExisting: boolean) {
  if (
    overwriteExisting &&
    (updates.drinkFromYear === undefined) !== (updates.drinkToYear === undefined)
  ) {
    throw new HTTPException(400, {
      message: "Edit drinkFromYear and drinkToYear together; use null for an unknown endpoint",
    });
  }
  if (
    wine.drinkFromYear !== null &&
    wine.drinkFromYear !== undefined &&
    wine.drinkToYear !== null &&
    wine.drinkToYear !== undefined &&
    wine.drinkFromYear > wine.drinkToYear
  ) {
    throw new HTTPException(400, { message: "Drink window must end on or after it starts" });
  }
  const status = wineVintageStatus(wine);
  if ((status === "year") !== (wine.vintageYear !== null && wine.vintageYear !== undefined)) {
    throw new HTTPException(400, {
      message: "Choose a known year, non-vintage, or unknown vintage consistently",
    });
  }
}

function whenDefined<T>(input: unknown, value: T): T | undefined {
  return input === undefined ? undefined : value;
}
