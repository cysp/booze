// oxlint-disable import/max-dependencies -- Complete bottle operations own wine preparation, related facts, authorization, and atomic audit.
import {
  bottleLocations,
  bottles,
  criticReviews,
  grapeVarieties,
  labelExtractions,
  storageLocations,
  wineAwards,
  wineries,
  wineVintages,
  wineConstituents,
  type BoozeDatabase,
} from "@chikachow/booze-db";
import { and, eq, getTableColumns, sql, type SQL } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { additionFingerprint, additionOperationIdSchema } from "../shared/addition-operation.ts";
import {
  bottleInputSchema,
  bottleQuantitySchema,
  wineInputSchema,
  winePatchInputSchema,
} from "../shared/catalogue-inputs.ts";
import { entityIdSchema } from "../shared/entity-id.ts";
import { formatWineDisplayName, hasWineIdentity } from "../shared/wine-identity.ts";
import { additionReceiptStatement, getAdditionReceipt } from "./addition-receipts.ts";
import { requireSitePermission } from "./api/auth.ts";
import { createBottleStatements, prepareWineVintage } from "./api/catalogue.ts";
import { retryCatalogueTransaction } from "./api/catalogue-transaction.ts";
import { criticReviewInputSchema, prepareCriticReviewStatements } from "./api/critic-reviews.ts";
import { optionalText } from "./api/ids.ts";
import { prepareWineAwardStatements } from "./api/wine-awards.ts";
import {
  commitOperation,
  createOperationAudit,
  operationAuditResultSchema,
  operationConstraintFailed,
  type OperationContext,
  type OperationStatement,
} from "./operation-transaction.ts";

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

export const createBottleSchema = z.object({
  operationId: additionOperationIdSchema,
  siteId: entityIdSchema,
  storageLocationId: entityIdSchema.nullable().optional(),
  positionHint: z.string().trim().max(120).optional(),
  quantity: bottleQuantitySchema.default(1),
  wine: wineInputSchema.optional(),
  wineVintageId: entityIdSchema.optional(),
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

export const patchBottleSchema = z.object({
  status: z.enum(["in_stock", "consumed"]).optional(),
  storageLocationId: entityIdSchema.nullable().optional(),
  positionHint: z.string().trim().max(120).optional(),
  bottle: bottleInputSchema.optional(),
  wine: winePatchInputSchema.optional(),
  wineVintageId: entityIdSchema.optional(),
  wineEditScope: z.enum(["shared", "bottle"]).optional(),
  expectedWineVintageId: entityIdSchema.optional(),
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

export const bottleOperationFactsSchema = z.object({
  bottleId: z.string(),
  siteId: z.string(),
  wineVintageId: z.string(),
  status: z.string(),
  storageLocationId: z.string().nullable(),
  positionHint: z.string().nullable(),
  wineBottleCount: z.number().int().min(0).optional(),
  bottle: z.record(z.string(), z.unknown()).optional(),
  wine: z.record(z.string(), z.unknown()).optional(),
  grapeConstituents: z.array(z.record(z.string(), z.unknown())).optional(),
  criticReviews: z.array(z.record(z.string(), z.unknown())).optional(),
  awards: z.array(z.record(z.string(), z.unknown())).optional(),
  labelExtractionIds: z.array(z.string()).optional(),
});

export type BottleOperationFacts = z.infer<typeof bottleOperationFactsSchema>;
export type BottleOperationResult = {
  readonly before: BottleOperationFacts;
  readonly after: BottleOperationFacts | null;
  readonly changed: boolean;
  readonly affectedRecordCount: number;
};

export async function addBottles(
  context: OperationContext,
  input: z.infer<typeof createBottleSchema>,
): Promise<z.infer<typeof bottleAdditionResultSchema>> {
  const payload = createBottleSchema.parse(input);
  const { database, userId } = context;
  const { siteId } = payload;
  await requireSitePermission({ ...context, siteId, permission: "site.content.write" });
  const operation = {
    userId,
    kind: "bottles" as const,
    operationId: payload.operationId,
    siteId,
    fingerprint: await additionFingerprint(payload),
  };
  const replay = await getAdditionReceipt(database, operation, bottleAdditionResultSchema);
  if (replay !== undefined) {
    await requireSitePermission({ ...context, siteId, permission: "site.content.write" });
    return replay;
  }
  const storageLocationId = payload.storageLocationId ?? null;
  if (storageLocationId !== null)
    await assertStorageLocationInSite({ database, siteId, storageLocationId });
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
    const { bottleIds } = creation;
    const statements = [...vintage.statements, ...creation.statements];
    if (payload.labelExtraction !== undefined)
      statements.push(
        ...createLabelExtractionStatements({
          database,
          bottleIds,
          wineVintageId: vintage.wineVintageId,
          labelExtraction: payload.labelExtraction,
        }),
      );
    if (payload.criticReviews !== undefined)
      statements.push(
        ...(await prepareCriticReviewStatements({
          database,
          reviews: payload.criticReviews,
          overwriteExisting: false,
          removeMissing: false,
          siteId,
          userId,
          wineVintageId: vintage.wineVintageId,
        })),
      );
    if (payload.awards !== undefined)
      statements.push(
        ...(await prepareWineAwardStatements({
          database,
          awards: payload.awards,
          overwriteExisting: false,
          removeMissing: false,
          siteId,
          userId,
          wineVintageId: vintage.wineVintageId,
        })),
      );
    const result = {
      bottleIds,
      siteId,
      storageLocationId,
      wineryId: vintage.wineryId,
      wineVintageId: vintage.wineVintageId,
    };
    const audit = createOperationAudit({
      context,
      siteId,
      action: "cellar.add_bottles",
      targetKind: "bottle",
      targetId: bottleIds[0] ?? vintage.wineVintageId,
      input: bottleAuditInput(payload),
      before: sql`'{}'`,
    });
    try {
      await commitOperation(context, siteId, [
        additionReceiptStatement(database, operation, result),
        audit.begin,
        ...statements,
        audit.finish(sql`${JSON.stringify(result)}`, sql`${bottleIds.length}`),
      ]);
    } catch (error) {
      // Only a durable receipt proves an uncertain acknowledgement committed.
      const committed = await getAdditionReceipt(database, operation, bottleAdditionResultSchema);
      if (committed !== undefined) {
        await requireSitePermission({ ...context, siteId, permission: "site.content.write" });
        return committed;
      }
      throw error;
    }
    return result;
  });
}

export async function editBottle(
  context: OperationContext,
  bottleId: string,
  input: z.infer<typeof patchBottleSchema>,
): Promise<BottleOperationResult> {
  const payload = patchBottleSchema.parse(input);
  return commitBottleEdit(context, bottleId, payload, "cellar.edit_bottle");
}

export async function moveBottle(
  context: OperationContext,
  bottleId: string,
  input: {
    readonly storageLocationId: string | null;
    readonly positionHint?: string | null;
  },
): Promise<BottleOperationResult> {
  return commitBottleEdit(
    context,
    bottleId,
    {
      storageLocationId: input.storageLocationId,
      ...(input.positionHint === undefined ? {} : { positionHint: input.positionHint ?? "" }),
    },
    "cellar.set_bottle_location",
  );
}

export async function consumeBottle(
  context: OperationContext,
  bottleId: string,
): Promise<BottleOperationResult> {
  return commitBottleEdit(context, bottleId, { status: "consumed" }, "cellar.mark_bottle_consumed");
}

export async function restoreBottle(
  context: OperationContext,
  bottleId: string,
): Promise<BottleOperationResult> {
  return commitBottleEdit(context, bottleId, { status: "in_stock" }, "cellar.restore_bottle");
}

async function commitBottleEdit(
  context: OperationContext,
  bottleId: string,
  payload: BottlePatch,
  action: string,
): Promise<BottleOperationResult> {
  const { database, userId } = context;
  const existing = await getBottleSiteAndVintage({ database, bottleId });
  const siteId = existing.siteId;
  await requireSitePermission({ ...context, siteId, permission: "site.content.write" });
  const moving = payload.storageLocationId !== undefined || payload.positionHint !== undefined;
  if (payload.storageLocationId !== undefined && payload.storageLocationId !== null)
    await assertStorageLocationInSite({
      database,
      siteId,
      storageLocationId: payload.storageLocationId,
    });
  return retryCatalogueTransaction(async () => {
    const vintage = await prepareEditedWine({ database, payload, existing, bottleId });
    const audit = createOperationAudit({
      context,
      siteId,
      action,
      targetKind: "bottle",
      targetId: bottleId,
      input: { bottleId, ...bottleAuditInput(payload) },
      before: bottleSnapshot(bottleId, payload),
    });
    const statements: OperationStatement[] = [...vintage.statements];
    if (payload.labelExtraction !== undefined && !hasWineEdits(payload))
      statements.unshift(
        wineEditGuard({
          database,
          bottleId,
          siteId,
          expectedWineVintageId: existing.wineVintageId,
          expectedCount: undefined,
          expectedIdentity: undefined,
        }),
      );
    statements.push(
      database
        .update(bottles)
        .set(
          bottleUpdateValues(
            payload,
            vintage.wineVintageId === existing.wineVintageId ? undefined : vintage.wineVintageId,
          ),
        )
        .where(eq(bottles.id, bottleId)),
    );
    if (payload.storageLocationId === null) {
      statements.push(
        database.delete(bottleLocations).where(eq(bottleLocations.bottleId, bottleId)),
      );
    } else if (payload.storageLocationId !== undefined) {
      const positionHint =
        payload.positionHint === undefined
          ? sql`(select case when storage_location_id = ${payload.storageLocationId} then position_hint else null end from bottle_locations where bottle_id = ${bottleId})`
          : optionalText(payload.positionHint);
      statements.push(
        database
          .insert(bottleLocations)
          .values({ bottleId, siteId, storageLocationId: payload.storageLocationId, positionHint })
          .onConflictDoUpdate({
            target: bottleLocations.bottleId,
            set: {
              storageLocationId: payload.storageLocationId,
              positionHint,
              updatedAt: sql`CURRENT_TIMESTAMP`,
            },
          }),
      );
    } else if (payload.positionHint !== undefined)
      statements.push(
        database
          .update(bottleLocations)
          .set({
            positionHint: optionalText(payload.positionHint),
            updatedAt: sql`CURRENT_TIMESTAMP`,
          })
          .where(eq(bottleLocations.bottleId, bottleId)),
      );
    if (payload.labelExtraction !== undefined)
      statements.push(
        ...createLabelExtractionStatements({
          database,
          bottleIds: [bottleId],
          wineVintageId: vintage.wineVintageId,
          labelExtraction: payload.labelExtraction,
        }),
      );
    if (payload.criticReviews !== undefined)
      statements.push(
        ...(await prepareCriticReviewStatements({
          database,
          reviews: payload.criticReviews,
          siteId,
          userId,
          wineVintageId: vintage.wineVintageId,
        })),
      );
    if (payload.awards !== undefined)
      statements.push(
        ...(await prepareWineAwardStatements({
          database,
          awards: payload.awards,
          siteId,
          userId,
          wineVintageId: vintage.wineVintageId,
        })),
      );
    try {
      const results = await commitOperation(context, siteId, [
        bottleGuard({
          database,
          bottleId,
          siteId,
          moving,
          storageLocationId: payload.storageLocationId,
        }),
        audit.begin,
        ...statements,
        audit.finish(bottleSnapshot(bottleId, payload)),
        audit.read,
      ]);
      return bottleResult(results.at(-1));
    } catch (error) {
      if (wineEditGuardFailed(error))
        throw new HTTPException(409, {
          message: "The wine or affected bottle count changed. Refresh before saving.",
          cause: error,
        });
      if (operationConstraintFailed(error, "NOT NULL constraint failed: bottles.site_id")) {
        const current = await getBottleSiteAndVintage({ database, bottleId });
        if (moving && current.status !== "in_stock")
          throw new HTTPException(400, {
            message: "Only in-stock bottles can be moved",
            cause: error,
          });
        if (payload.storageLocationId !== undefined && payload.storageLocationId !== null)
          await assertStorageLocationInSite({
            database,
            siteId,
            storageLocationId: payload.storageLocationId,
          });
        throw new HTTPException(409, {
          message: "The bottle changed while saving. Refresh before saving.",
          cause: error,
        });
      }
      throw error;
    }
  });
}

export async function deleteBottle(
  context: OperationContext,
  bottleId: string,
): Promise<BottleOperationResult> {
  const { database } = context;
  const { siteId } = await getBottleSiteAndVintage({ database, bottleId });
  await requireSitePermission({ ...context, siteId, permission: "site.content.write" });
  const audit = createOperationAudit({
    context,
    siteId,
    action: "cellar.delete_bottle",
    targetKind: "bottle",
    targetId: bottleId,
    input: { bottleId },
    before: bottleSnapshot(bottleId),
  });
  const results = await commitOperation(context, siteId, [
    bottleGuard({ database, bottleId, siteId, moving: false }),
    audit.begin,
    database.delete(labelExtractions).where(eq(labelExtractions.bottleId, bottleId)),
    database.delete(bottleLocations).where(eq(bottleLocations.bottleId, bottleId)),
    database.delete(bottles).where(eq(bottles.id, bottleId)),
    audit.finish(sql`'{}'`),
    audit.read,
  ]);
  return bottleResult(results.at(-1));
}

function bottleResult(rows: unknown): BottleOperationResult {
  const [event] = z.array(operationAuditResultSchema).parse(rows);
  if (event === undefined) throw new Error("Bottle operation did not return its committed audit");
  const after: unknown = JSON.parse(event.afterJson);
  return {
    before: bottleOperationFactsSchema.parse(JSON.parse(event.beforeJson)),
    after:
      typeof after === "object" && after !== null && Object.keys(after).length === 0
        ? null
        : bottleOperationFactsSchema.parse(after),
    changed: event.affectedRecordCount !== 0,
    affectedRecordCount: event.affectedRecordCount,
  };
}

function bottleGuard({
  database,
  bottleId,
  siteId,
  moving,
  storageLocationId,
}: {
  readonly database: BoozeDatabase;
  readonly bottleId: string;
  readonly siteId: string;
  readonly moving: boolean;
  readonly storageLocationId?: string | null | undefined;
}): OperationStatement {
  return database
    .insert(bottles)
    .values({
      id: bottleId,
      siteId: sql`(select site_id from bottles where id = ${bottleId} and site_id = ${siteId}
      and (${moving ? 1 : 0} = 0 or status = 'in_stock')
      and (${storageLocationId ?? null} is null or exists (select 1 from storage_locations where id = ${storageLocationId ?? null} and site_id = ${siteId})))`,
      wineVintageId: sql`(select wine_vintage_id from bottles where id = ${bottleId})`,
    })
    .onConflictDoNothing({ target: bottles.id });
}

function bottleAuditInput(
  payload: BottlePatch | z.infer<typeof createBottleSchema>,
): Readonly<Record<string, unknown>> {
  return {
    ...payload,
    ...(payload.labelExtraction === undefined
      ? {}
      : {
          labelExtraction: {
            confidence: payload.labelExtraction.confidence ?? null,
            requiresReview: payload.labelExtraction.requiresReview ?? false,
          },
        }),
  };
}

function jsonRow(
  table:
    | typeof bottles
    | typeof wineVintages
    | typeof wineConstituents
    | typeof criticReviews
    | typeof wineAwards,
  keys?: readonly string[],
): SQL {
  const fields = Object.entries(getTableColumns(table)).filter(
    ([key]) =>
      key !== "createdAt" && key !== "updatedAt" && (keys === undefined || keys.includes(key)),
  );
  return sql`json_object(${sql.join(
    fields.flatMap(([key, column]) => [sql`${key}`, sql`${column}`]),
    sql`, `,
  )})`;
}

function bottleSnapshot(bottleId: string, payload: BottlePatch = {}): SQL {
  const fields = [
    sql`'bottleId', ${bottles.id}`,
    sql`'siteId', ${bottles.siteId}`,
    sql`'wineVintageId', ${bottles.wineVintageId}`,
    sql`'status', ${bottles.status}`,
    sql`'storageLocationId', ${bottleLocations.storageLocationId}`,
    sql`'positionHint', ${bottleLocations.positionHint}`,
  ];
  if (payload.bottle !== undefined)
    fields.push(sql`'bottle', json(${jsonRow(bottles, Object.keys(payload.bottle))})`);
  if (hasWineEdits(payload))
    fields.push(
      sql`'wineBottleCount', (select count(*) from bottles related where related.site_id = ${bottles.siteId} and related.wine_vintage_id = ${bottles.wineVintageId})`,
    );
  if (payload.wine !== undefined) {
    const keys = [
      ...Object.keys(payload.wine),
      "wineryId",
      "baseName",
      "displayName",
      "vintageLabel",
      "vintageYear",
      "vintageStatus",
    ];
    fields.push(sql`'wine', json(${jsonRow(wineVintages, keys)})`);
  }
  if (
    payload.wine?.grapeVarieties !== undefined ||
    (payload.wineEditScope === "bottle" && payload.wine !== undefined)
  )
    fields.push(
      sql`'grapeConstituents', json((select json_group_array(json(row_json)) from (select ${jsonRow(wineConstituents)} row_json from ${wineConstituents} where ${wineConstituents.wineVintageId} = ${bottles.wineVintageId} order by ${wineConstituents.grapeVarietyId})))`,
    );
  if (payload.criticReviews !== undefined)
    fields.push(
      sql`'criticReviews', json((select json_group_array(json(row_json)) from (select ${jsonRow(criticReviews)} row_json from ${criticReviews} where ${criticReviews.wineVintageId} = ${bottles.wineVintageId} order by ${criticReviews.id})))`,
    );
  if (payload.awards !== undefined)
    fields.push(
      sql`'awards', json((select json_group_array(json(row_json)) from (select ${jsonRow(wineAwards)} row_json from ${wineAwards} where ${wineAwards.wineVintageId} = ${bottles.wineVintageId} order by ${wineAwards.id})))`,
    );
  if (payload.labelExtraction !== undefined)
    fields.push(
      sql`'labelExtractionIds', json((select json_group_array(id) from (select id from label_extractions where bottle_id = ${bottles.id} order by id)))`,
    );
  return sql`(select json_object(${sql.join(fields, sql`, `)}) from ${bottles}
    join ${wineVintages} on ${wineVintages.id} = ${bottles.wineVintageId}
    left join ${bottleLocations} on ${bottleLocations.bottleId} = ${bottles.id} where ${bottles.id} = ${bottleId})`;
}

async function getBottleSiteAndVintage({
  database,
  bottleId,
}: {
  readonly database: BoozeDatabase;
  readonly bottleId: string;
}): Promise<{ readonly siteId: string; readonly wineVintageId: string; readonly status: string }> {
  const rows = await database
    .select({
      siteId: bottles.siteId,
      wineVintageId: bottles.wineVintageId,
      status: bottles.status,
    })
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
