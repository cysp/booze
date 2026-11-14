// oxlint-disable import/max-dependencies -- Bottle route composes the full catalogue aggregate and related writes.
import {
  bottleLocations,
  bottles,
  createD1Client,
  labelExtractions,
  storageLocations,
  wineries,
  wineVintages,
  wineConstituents,
  grapeVarieties,
  type BoozeDatabase,
} from "@chikachow/booze-db";
import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { additionFingerprint, additionOperationIdSchema } from "../../shared/addition-operation.ts";
import { additionReceiptStatement, getAdditionReceipt } from "../addition-receipts.ts";
import { formatWineDisplayName, hasWineIdentity } from "../../shared/wine-identity.ts";

import { requireAuthenticatedUser, requireSitePermission } from "../api/auth.ts";
import { createBottleStatements, prepareWineVintage } from "../api/catalogue.ts";
import { prepareCriticReviewStatements } from "../api/critic-reviews.ts";
import { retryCatalogueTransaction } from "../api/catalogue-transaction.ts";
import { created, locationHeader, noContent } from "../api/http.ts";
import { optionalText } from "../api/ids.ts";
import { listBottles } from "../api/inventory.ts";
import { prepareWineAwardStatements } from "../api/wine-awards.ts";
import { criticReviewInputSchema } from "./critic-reviews.ts";
import type { Bindings } from "../api/types.ts";

const wineInputSchema = z.object({
  wineryName: z.string().trim().max(160),
  brandName: z.string().trim().max(160).optional(),
  baseName: z.string().trim().max(180).optional(),
  designation: z.string().trim().max(160).nullable().optional(),
  displayName: z.string().trim().max(180).optional(),
  vintageYear: z.number().int().min(1800).max(2200).nullable().optional(),
  vintageStatus: z.enum(["year", "non_vintage", "unknown"]).optional(),
  grapeVarieties: z.array(z.string().trim().min(1).max(120)).max(24).optional(),
  country: z.string().trim().max(120).optional(),
  region: z.string().trim().max(160).optional(),
  appellation: z.string().trim().max(160).optional(),
  classification: z.string().trim().max(160).optional(),
  wineType: z.string().trim().max(120).optional(),
  wineColor: z.string().trim().max(40).optional(),
  addressQualification: z.string().trim().max(500).optional(),
  alcoholPercent: z.number().min(0).max(100).optional(),
  drinkFromYear: z.number().int().min(1800).max(2200).optional(),
  drinkToYear: z.number().int().min(1800).max(2200).optional(),
  description: z.string().trim().max(2_000).optional(),
  drinkingAdvice: z.string().trim().max(2_000).optional(),
  labelText: z.string().trim().max(4_000).optional(),
  sourceUrl: z.url().trim().max(500).optional().or(z.literal("")),
  notes: z.string().trim().max(2_000).optional(),
});

const bottleInputSchema = z.object({
  bottleNumber: z.string().trim().max(80).optional(),
  volumeMl: z.number().int().min(1).max(30_000).optional(),
  barcode: z.string().trim().max(80).optional(),
  lotCode: z.string().trim().max(120).optional(),
  notes: z.string().trim().max(2_000).optional(),
});

const wineAwardInputSchema = z.object({
  id: z.string().trim().min(1).max(120).optional(),
  awardName: z.string().trim().min(1).max(180),
  awardLevel: z.string().trim().min(1).max(80),
  awardYear: z.number().int().min(1800).max(2200).optional(),
  awardBody: z.string().trim().max(180).optional(),
  category: z.string().trim().max(180).optional(),
  points: z.number().min(0).max(1000).optional(),
  sourceUrl: z.url().trim().max(500).optional().or(z.literal("")),
  provenance: z.string().trim().max(500).optional(),
  notes: z.string().trim().max(1_000).optional(),
});

const createBottleSchema = z.object({
  operationId: additionOperationIdSchema,
  siteId: z.string().trim().min(1),
  storageLocationId: z.string().trim().min(1).nullable().optional(),
  positionHint: z.string().trim().max(120).optional(),
  quantity: z.number().int().min(1).max(24).default(1),
  wine: wineInputSchema.optional(),
  wineVintageId: z.string().trim().min(1).optional(),
  allowUnidentified: z.boolean().optional(),
  bottle: bottleInputSchema.default({}),
  labelExtraction: z
    .object({
      extractedFieldsJson: z.string().trim().min(1).max(80_000),
      rawTextJson: z.string().trim().max(80_000).optional(),
      confidence: z.number().min(0).max(1).optional(),
      requiresReview: z.boolean().optional(),
    })
    .optional(),
  criticReviews: z.array(criticReviewInputSchema).max(24).optional(),
  awards: z.array(wineAwardInputSchema).max(24).optional(),
});

const patchWineSchema = wineInputSchema.partial().extend({
  brandName: wineInputSchema.shape.brandName.nullable(),
  vintageYear: wineInputSchema.shape.vintageYear.nullable(),
  country: wineInputSchema.shape.country.nullable(),
  region: wineInputSchema.shape.region.nullable(),
  appellation: wineInputSchema.shape.appellation.nullable(),
  classification: wineInputSchema.shape.classification.nullable(),
  wineType: wineInputSchema.shape.wineType.nullable(),
  wineColor: wineInputSchema.shape.wineColor.nullable(),
  addressQualification: wineInputSchema.shape.addressQualification.nullable(),
  alcoholPercent: wineInputSchema.shape.alcoholPercent.nullable(),
  drinkFromYear: wineInputSchema.shape.drinkFromYear.nullable(),
  drinkToYear: wineInputSchema.shape.drinkToYear.nullable(),
  description: wineInputSchema.shape.description.nullable(),
  drinkingAdvice: wineInputSchema.shape.drinkingAdvice.nullable(),
  labelText: wineInputSchema.shape.labelText.nullable(),
  sourceUrl: wineInputSchema.shape.sourceUrl.nullable(),
  notes: wineInputSchema.shape.notes.nullable(),
});

const patchBottleSchema = z.object({
  status: z.enum(["in_stock", "consumed"]).optional(),
  storageLocationId: z.string().trim().min(1).nullable().optional(),
  positionHint: z.string().trim().max(120).optional(),
  bottle: bottleInputSchema.optional(),
  wine: patchWineSchema.optional(),
  wineVintageId: z.string().trim().min(1).optional(),
  wineEditScope: z.enum(["shared", "bottle"]).optional(),
  expectedWineVintageId: z.string().trim().min(1).optional(),
  expectedAffectedBottleCount: z.number().int().min(1).optional(),
  allowUnidentified: z.boolean().optional(),
  labelExtraction: createBottleSchema.shape.labelExtraction,
  criticReviews: z.array(criticReviewInputSchema).max(24).optional(),
  awards: z.array(wineAwardInputSchema).max(24).optional(),
});

const bottleAdditionResultSchema = z.object({
  bottleIds: z.array(z.string()).min(1).readonly(),
  siteId: z.string(),
  storageLocationId: z.string().nullable(),
  wineryId: z.string().nullable(),
  wineVintageId: z.string(),
});

export const bottleRoutes = new Hono<{ Bindings: Bindings }>()
  .get("/bottles", async (context) => {
    const database = createD1Client(context.env.DB);
    const authenticatedUser = await requireAuthenticatedUser({
      database,
      request: context.req.raw,
      headers: context.req.raw.headers,
      secretKey: context.env.CLERK_SECRET_KEY,
    });

    const rows = await listBottles({ database, userId: authenticatedUser.userId });
    return context.json({ data: rows });
  })
  .post("/bottles", async (context) => {
    const payload = createBottleSchema.parse(await context.req.json());
    const database = createD1Client(context.env.DB);
    const authenticatedUser = await requireAuthenticatedUser({
      database,
      request: context.req.raw,
      headers: context.req.raw.headers,
      secretKey: context.env.CLERK_SECRET_KEY,
    });

    const siteId = payload.siteId;

    await requireSitePermission({
      database,
      permission: "site.content.write",
      siteId,
      userId: authenticatedUser.userId,
    });

    const operation = {
      userId: authenticatedUser.userId,
      kind: "bottles" as const,
      operationId: payload.operationId,
      siteId,
      fingerprint: await additionFingerprint(payload),
    };
    const replay = await getAdditionReceipt(database, operation, bottleAdditionResultSchema);
    if (replay !== undefined) return bottleAdditionResponse(replay);

    const storageLocationId = payload.storageLocationId ?? null;

    if (storageLocationId !== null) {
      await assertStorageLocationInSite({ database, siteId, storageLocationId });
    }

    return retryCatalogueTransaction(async () => {
      const vintage = await prepareCreatedWine({ database, siteId, payload });
      const creation = createBottleStatements({
        database,
        siteId,
        wineVintageId: vintage.wineVintageId,
        storageLocationId,
        positionHint: optionalText(payload.positionHint),
        bottle: payload.bottle,
        quantity: payload.quantity,
      });

      const bottleIds = creation.bottleIds;
      const statements = [...vintage.statements, ...creation.statements];
      if (payload.labelExtraction !== undefined) {
        statements.push(
          ...createLabelExtractionStatements({
            database,
            bottleIds,
            wineVintageId: vintage.wineVintageId,
            labelExtraction: payload.labelExtraction,
          }),
        );
      }

      if (payload.criticReviews !== undefined) {
        statements.push(
          ...(await prepareCriticReviewStatements({
            database,
            reviews: payload.criticReviews,
            overwriteExisting: false,
            removeMissing: false,
            siteId,
            userId: authenticatedUser.userId,
            wineVintageId: vintage.wineVintageId,
          })),
        );
      }

      if (payload.awards !== undefined) {
        statements.push(
          ...(await prepareWineAwardStatements({
            awards: payload.awards,
            overwriteExisting: false,
            removeMissing: false,
            database,
            siteId,
            userId: authenticatedUser.userId,
            wineVintageId: vintage.wineVintageId,
          })),
        );
      }

      const result = {
        bottleIds,
        siteId,
        storageLocationId,
        wineryId: vintage.wineryId,
        wineVintageId: vintage.wineVintageId,
      };
      try {
        await database.batch([
          additionReceiptStatement(database, operation, result),
          ...statements,
        ]);
      } catch (error) {
        // A concurrent winner or a committed batch with a lost acknowledgement
        // is resolved by its durable receipt; unrelated failures still surface.
        const committed = await getAdditionReceipt(database, operation, bottleAdditionResultSchema);
        if (committed !== undefined) return bottleAdditionResponse(committed);
        throw error;
      }
      return bottleAdditionResponse(result);
    });
  })
  .patch("/bottles/:bottleId", async (context) => {
    const payload = patchBottleSchema.parse(await context.req.json());
    const database = createD1Client(context.env.DB);
    const authenticatedUser = await requireAuthenticatedUser({
      database,
      request: context.req.raw,
      headers: context.req.raw.headers,
      secretKey: context.env.CLERK_SECRET_KEY,
    });
    const bottleId = context.req.param("bottleId");
    const existing = await getBottleSiteAndVintage({ database, bottleId });

    await requireSitePermission({
      database,
      permission: "site.content.write",
      siteId: existing.siteId,
      userId: authenticatedUser.userId,
    });

    if (payload.storageLocationId !== null && payload.storageLocationId !== undefined) {
      await assertStorageLocationInSite({
        database,
        siteId: existing.siteId,
        storageLocationId: payload.storageLocationId,
      });
    }
    return retryCatalogueTransaction(async () => {
      const nextVintage = await prepareEditedWine({ database, payload, existing, bottleId });
      const statements: Parameters<BoozeDatabase["batch"]>[0][number][] = [
        ...nextVintage.statements,
      ];

      const bottleUpdate = database
        .update(bottles)
        .set(
          bottleUpdateValues(
            payload,
            nextVintage.wineVintageId === existing.wineVintageId
              ? undefined
              : nextVintage.wineVintageId,
          ),
        )
        .where(eq(bottles.id, bottleId));
      statements.push(bottleUpdate);

      if (payload.storageLocationId !== undefined) {
        statements.push(
          database.delete(bottleLocations).where(eq(bottleLocations.bottleId, bottleId)),
        );
        if (payload.storageLocationId !== null) {
          statements.push(
            database.insert(bottleLocations).values({
              bottleId,
              siteId: existing.siteId,
              storageLocationId: payload.storageLocationId,
              positionHint: optionalText(payload.positionHint),
            }),
          );
        }
      } else if (payload.positionHint !== undefined) {
        statements.push(
          database
            .update(bottleLocations)
            .set({
              positionHint: optionalText(payload.positionHint),
              updatedAt: sql`CURRENT_TIMESTAMP`,
            })
            .where(eq(bottleLocations.bottleId, bottleId)),
        );
      }
      if (payload.labelExtraction !== undefined) {
        statements.push(
          ...createLabelExtractionStatements({
            database,
            bottleIds: [bottleId],
            wineVintageId: nextVintage.wineVintageId,
            labelExtraction: payload.labelExtraction,
          }),
        );
      }

      if (payload.criticReviews !== undefined) {
        statements.push(
          ...(await prepareCriticReviewStatements({
            database,
            reviews: payload.criticReviews,
            siteId: existing.siteId,
            userId: authenticatedUser.userId,
            wineVintageId: nextVintage.wineVintageId,
          })),
        );
      }

      if (payload.awards !== undefined) {
        statements.push(
          ...(await prepareWineAwardStatements({
            awards: payload.awards,
            database,
            siteId: existing.siteId,
            userId: authenticatedUser.userId,
            wineVintageId: nextVintage.wineVintageId,
          })),
        );
      }

      const [first, ...rest] = statements;
      if (first !== undefined) {
        try {
          await database.batch([first, ...rest]);
        } catch (error) {
          if (wineEditGuardFailed(error))
            throw new HTTPException(409, {
              message: "The wine or affected bottle count changed. Refresh before saving.",
              cause: error,
            });
          throw error;
        }
      }
      return context.json({ data: { id: bottleId } });
    });
  })
  .delete("/bottles/:bottleId", async (context) => {
    const database = createD1Client(context.env.DB);
    const authenticatedUser = await requireAuthenticatedUser({
      database,
      request: context.req.raw,
      headers: context.req.raw.headers,
      secretKey: context.env.CLERK_SECRET_KEY,
    });
    const bottleId = context.req.param("bottleId");
    const existing = await getBottleSiteAndVintage({ database, bottleId });

    await requireSitePermission({
      database,
      permission: "site.content.write",
      siteId: existing.siteId,
      userId: authenticatedUser.userId,
    });
    await database.batch([
      database.delete(labelExtractions).where(eq(labelExtractions.bottleId, bottleId)),
      database.delete(bottleLocations).where(eq(bottleLocations.bottleId, bottleId)),
      database.delete(bottles).where(eq(bottles.id, bottleId)),
    ]);

    return noContent();
  });

async function getBottleSiteAndVintage({
  database,
  bottleId,
}: {
  readonly database: BoozeDatabase;
  readonly bottleId: string;
}): Promise<{ readonly siteId: string; readonly wineVintageId: string }> {
  const rows = await database
    .select({ siteId: bottles.siteId, wineVintageId: bottles.wineVintageId })
    .from(bottles)
    .where(eq(bottles.id, bottleId))
    .limit(1);

  const row = rows[0];
  if (row === undefined) {
    throw new HTTPException(404, { message: "Bottle not found" });
  }
  return row;
}

async function assertStorageLocationInSite({
  database,
  siteId,
  storageLocationId,
}: {
  readonly database: BoozeDatabase;
  readonly siteId: string;
  readonly storageLocationId: string;
}): Promise<void> {
  const rows = await database
    .select({ id: storageLocations.id })
    .from(storageLocations)
    .where(and(eq(storageLocations.id, storageLocationId), eq(storageLocations.siteId, siteId)))
    .limit(1);

  if (rows[0] === undefined) {
    throw new HTTPException(400, { message: "Storage location is not in the bottle site" });
  }
}

function createLabelExtractionStatements({
  database,
  bottleIds,
  wineVintageId,
  labelExtraction,
}: {
  readonly database: BoozeDatabase;
  readonly bottleIds: readonly string[];
  readonly wineVintageId: string;
  readonly labelExtraction: NonNullable<z.infer<typeof createBottleSchema>["labelExtraction"]>;
}): Parameters<BoozeDatabase["batch"]>[0][number][] {
  return bottleIds.map((bottleId) =>
    database.insert(labelExtractions).values({
      id: crypto.randomUUID(),
      bottleId,
      wineVintageId,
      provider: null,
      model: null,
      rawTextJson: optionalText(labelExtraction.rawTextJson),
      extractedFieldsJson: labelExtraction.extractedFieldsJson,
      confidence: labelExtraction.confidence ?? null,
      requiresReview: labelExtraction.requiresReview ?? false,
    }),
  );
}

async function wineInputForVintage({
  database,
  wineVintageId,
}: {
  readonly database: BoozeDatabase;
  readonly wineVintageId: string;
}) {
  const rows = await database
    .select({ wine: wineVintages, wineryName: wineries.name })
    .from(wineVintages)
    .leftJoin(wineries, eq(wineVintages.wineryId, wineries.id))
    .where(eq(wineVintages.id, wineVintageId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) throw new HTTPException(404, { message: "Wine vintage not found" });
  return {
    ...row.wine,
    wineryName: row.wineryName ?? "",
    vintageStatus: row.wine.vintageYear === null ? row.wine.vintageStatus : ("year" as const),
    grapeVarieties: (
      await database
        .select({ name: grapeVarieties.name })
        .from(wineConstituents)
        .innerJoin(grapeVarieties, eq(wineConstituents.grapeVarietyId, grapeVarieties.id))
        .where(eq(wineConstituents.wineVintageId, wineVintageId))
    ).map((grape) => grape.name),
    designation: row.wine.designation,
  };
}

function bottleUpdateValues(
  payload: z.infer<typeof patchBottleSchema>,
  wineVintageId: string | undefined,
) {
  return {
    ...(payload.status === undefined ? {} : { status: payload.status }),
    ...(payload.bottle?.bottleNumber === undefined
      ? {}
      : { bottleNumber: optionalText(payload.bottle.bottleNumber) }),
    ...(payload.bottle?.volumeMl === undefined ? {} : { volumeMl: payload.bottle.volumeMl }),
    ...(payload.bottle?.barcode === undefined
      ? {}
      : { barcode: optionalText(payload.bottle.barcode) }),
    ...(payload.bottle?.lotCode === undefined
      ? {}
      : { lotCode: optionalText(payload.bottle.lotCode) }),
    ...(payload.bottle?.notes === undefined ? {} : { notes: optionalText(payload.bottle.notes) }),
    ...(wineVintageId === undefined ? {} : { wineVintageId }),
    updatedAt: sql`CURRENT_TIMESTAMP`,
  };
}

async function existingWine({
  database,
  siteId,
  wineVintageId,
}: {
  readonly database: BoozeDatabase;
  readonly siteId: string;
  readonly wineVintageId: string;
}) {
  const rows = await database
    .select({ wineryId: wineVintages.wineryId })
    .from(wineVintages)
    .where(and(eq(wineVintages.siteId, siteId), eq(wineVintages.id, wineVintageId)))
    .limit(1);
  const row = rows[0];
  if (row === undefined) throw new HTTPException(404, { message: "Wine not found in this site" });
  return { wineryId: row.wineryId, wineVintageId, statements: [] };
}

function wineEditGuard({
  database,
  bottleId,
  siteId,
  expectedWineVintageId,
  expectedCount,
  expectedIdentity,
}: {
  readonly database: BoozeDatabase;
  readonly bottleId: string;
  readonly siteId: string;
  readonly expectedWineVintageId: string;
  readonly expectedCount: number | undefined;
  readonly expectedIdentity: Awaited<ReturnType<typeof wineInputForVintage>> | undefined;
}) {
  // A stale selection yields NULL for a required column before the ID conflict
  // no-op, rolling back every dependent statement in the D1 batch.
  return database
    .insert(bottles)
    .values({
      id: bottleId,
      siteId,
      wineVintageId: sql`(select id from wine_vintages where id = ${expectedWineVintageId} and site_id = ${siteId}
      and exists (select 1 from bottles where id = ${bottleId} and wine_vintage_id = ${expectedWineVintageId})
      and (${expectedCount ?? null} is null or (select count(*) from bottles where site_id = ${siteId} and wine_vintage_id = ${expectedWineVintageId}) = ${expectedCount ?? null})
      and ${expectedIdentity === undefined ? sql`1` : unchangedWineIdentity(expectedIdentity)})`,
    })
    .onConflictDoNothing({ target: bottles.id });
}

function wineEditGuardFailed(error: unknown): boolean {
  const seen = new Set<Error>();
  let cause = error;
  while (cause instanceof Error && !seen.has(cause)) {
    seen.add(cause);
    if (cause.message.includes("NOT NULL constraint failed: bottles.wine_vintage_id")) return true;
    cause = cause.cause;
  }
  return false;
}

function unchangedWineIdentity(wine: Awaited<ReturnType<typeof wineInputForVintage>>) {
  // Titles and cloned composition depend on these facts as a group. Reject
  // mixed identity snapshots while allowing newer constituent measurements.
  return sql`winery_id is ${wine.wineryId} and brand_name is ${wine.brandName}
    and designation is ${wine.designation} and appellation is ${wine.appellation} and region is ${wine.region}
    and display_name is ${wine.displayName}
    and (select count(*) from wine_constituents where wine_vintage_id = ${wine.id}) = ${wine.grapeVarieties.length}
    and not exists (select 1 from wine_constituents c join grape_varieties g on c.grape_variety_id = g.id
      where c.wine_vintage_id = ${wine.id} and g.name not in (select value from json_each(${JSON.stringify(wine.grapeVarieties)})))`;
}

type BottlePatch = z.infer<typeof patchBottleSchema>;
type CurrentBottle = { readonly siteId: string; readonly wineVintageId: string };

async function prepareCreatedWine({
  database,
  siteId,
  payload,
}: {
  readonly database: BoozeDatabase;
  readonly siteId: string;
  readonly payload: z.infer<typeof createBottleSchema>;
}) {
  if (payload.wineVintageId === undefined) {
    if (payload.wine === undefined)
      throw new HTTPException(400, { message: "Enter wine details or select an existing wine" });
    requireIdentifiedWine(payload.wine, payload.allowUnidentified);
    return prepareWineVintage({ database, siteId, wine: payload.wine });
  }
  if (payload.criticReviews !== undefined || payload.awards !== undefined) {
    throw new HTTPException(400, {
      message: "Use Correct wine details to change an existing wine's reviews or awards",
    });
  }
  return existingWine({ database, siteId, wineVintageId: payload.wineVintageId });
}

function hasWineEdits(payload: BottlePatch): boolean {
  return (
    payload.wine !== undefined ||
    payload.wineVintageId !== undefined ||
    payload.criticReviews !== undefined ||
    payload.awards !== undefined
  );
}

function validateWineEditScope(payload: BottlePatch, existing: CurrentBottle) {
  if (!hasWineEdits(payload)) return;
  if (payload.wineEditScope === undefined || payload.expectedWineVintageId === undefined) {
    throw new HTTPException(400, {
      message:
        "Choose Correct wine details or This bottle is a different wine before changing wine facts",
    });
  }
  if (payload.expectedWineVintageId !== existing.wineVintageId) {
    throw new HTTPException(409, { message: "This bottle's wine changed. Refresh before saving." });
  }
  if (payload.wineEditScope === "shared" && payload.expectedAffectedBottleCount === undefined) {
    throw new HTTPException(400, {
      message: "Confirm the number of bottles affected by this wine correction",
    });
  }
  const changesMetadata = payload.criticReviews !== undefined || payload.awards !== undefined;
  if (
    payload.wineVintageId !== undefined &&
    (payload.wineEditScope !== "bottle" || payload.wine !== undefined || changesMetadata)
  ) {
    throw new HTTPException(400, {
      message: "Reassigning to an existing wine cannot also change its shared details",
    });
  }
  if (
    payload.wineEditScope === "bottle" &&
    payload.wine === undefined &&
    payload.wineVintageId === undefined &&
    changesMetadata
  ) {
    throw new HTTPException(400, {
      message:
        "Choose shared wine correction or enter the different wine's details before changing reviews or awards",
    });
  }
}

function changesWineIdentity(wine: BottlePatch["wine"]): boolean {
  return (
    wine !== undefined &&
    ["wineryName", "brandName", "designation", "grapeVarieties", "appellation"].some((key) =>
      Object.hasOwn(wine, key),
    )
  );
}

function requireIdentifiedWine(
  wine: Parameters<typeof hasWineIdentity>[0],
  allowUnidentified: boolean | undefined,
) {
  if (!hasWineIdentity(wine) && allowUnidentified !== true) {
    throw new HTTPException(400, {
      message: "Confirm saving as unidentified wine, or enter a producer and wine details",
    });
  }
}

function correctedWineInput(
  previous: Awaited<ReturnType<typeof wineInputForVintage>>,
  updates: NonNullable<BottlePatch["wine"]>,
) {
  const identityChanged = changesWineIdentity(updates);
  const wine = {
    ...previous,
    ...updates,
    ...(identityChanged ? { displayName: updates.displayName, baseName: updates.baseName } : {}),
    ...(updates.vintageYear !== undefined && updates.vintageStatus === undefined
      ? { vintageStatus: updates.vintageYear === null ? ("unknown" as const) : ("year" as const) }
      : {}),
    wineryName: updates.wineryName ?? previous.wineryName,
  };
  if (identityChanged && optionalText(updates.displayName) === null) {
    wine.displayName = formatWineDisplayName(wine);
  }
  return wine;
}

async function prepareEditedWine({
  database,
  payload,
  existing,
  bottleId,
}: {
  readonly database: BoozeDatabase;
  readonly payload: BottlePatch;
  readonly existing: CurrentBottle;
  readonly bottleId: string;
}) {
  validateWineEditScope(payload, existing);
  const previous =
    payload.wine === undefined
      ? undefined
      : await wineInputForVintage({ database, wineVintageId: existing.wineVintageId });
  const guard = hasWineEdits(payload)
    ? [
        wineEditGuard({
          database,
          bottleId,
          siteId: existing.siteId,
          expectedWineVintageId: existing.wineVintageId,
          expectedCount:
            payload.wineEditScope === "shared" ? payload.expectedAffectedBottleCount : undefined,
          expectedIdentity:
            payload.wineEditScope === "bottle" ||
            changesWineIdentity(payload.wine) ||
            payload.wine?.region !== undefined
              ? previous
              : undefined,
        }),
      ]
    : [];
  if (payload.wineVintageId !== undefined) {
    const target = await existingWine({
      database,
      siteId: existing.siteId,
      wineVintageId: payload.wineVintageId,
    });
    return { ...target, statements: guard };
  }
  if (payload.wine === undefined || previous === undefined)
    return { wineVintageId: existing.wineVintageId, statements: guard };
  const wine = correctedWineInput(previous, payload.wine);
  if (payload.wineEditScope === "bottle" || changesWineIdentity(payload.wine))
    requireIdentifiedWine(wine, payload.allowUnidentified);
  const vintage = await prepareWineVintage({
    database,
    siteId: existing.siteId,
    wine: {
      ...wine,
      ...(payload.wineEditScope === "bottle" && payload.wine.grapeVarieties === undefined
        ? { grapeVarieties: undefined }
        : {}),
    },
    overwriteExisting: true,
    updates: payload.wine,
    sourceWineVintageId: existing.wineVintageId,
    ...(payload.wineEditScope === "shared"
      ? { existingWineVintageId: existing.wineVintageId }
      : {}),
  });
  return { ...vintage, statements: [...guard, ...vintage.statements] };
}

function bottleAdditionResponse(result: z.infer<typeof bottleAdditionResultSchema>) {
  return created(result, locationHeader(`/api/bottles/${result.bottleIds[0]}`));
}
