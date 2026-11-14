import {
  bottleCaptureRuns,
  bottleCaptures,
  bottleLocations,
  bottles,
  storageLocations,
  createD1Client,
  wineVintages,
  type BoozeDatabase,
} from "@chikachow/booze-db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";

import { createBottleStatements, prepareWineVintage } from "./api/catalogue.ts";
import { stableId } from "./api/ids.ts";
import { retryCatalogueTransaction } from "./api/catalogue-transaction.ts";
import { bottleQuantitySchema, catalogueCandidateSchema } from "../shared/catalogue-inputs.ts";
import type { ImportCandidate } from "./bottle-extractor.ts";
import { commitOperation } from "./operation-transaction.ts";
import { latestCaptureRunId, type CaptureImportClaim } from "./capture-store.ts";

export type BottleImportResult = {
  readonly kind: "imported";
  readonly bottleIds: readonly string[];
  readonly wineVintageId: string;
  readonly wineryId: string | null;
  readonly matchResult: BottleMatchResult;
};

export type BottleMatchResult =
  | {
      readonly kind: "create_new";
      readonly wineryCandidates: readonly MatchCandidate[];
      readonly wineVintageCandidates: readonly MatchCandidate[];
    }
  | {
      readonly kind: "reuse_wine_vintage";
      readonly wineryCandidates: readonly MatchCandidate[];
      readonly wineVintageCandidate: MatchCandidate;
      readonly wineVintageCandidates: readonly MatchCandidate[];
    };

export type MatchCandidate = {
  readonly id: string;
  readonly label: string;
};

type CaptureImportInput = {
  readonly candidate: ImportCandidate;
  readonly captureId: string;
  readonly database: BoozeDatabase;
  readonly quantity: number;
  readonly userId: string;
  readonly siteId: string;
  readonly runId: string;
  readonly workflowInstanceId: string | null;
  readonly expectedReviewRevision: number;
  readonly wineVintageId?: string | undefined;
};

export class CaptureImportConflictError extends HTTPException {
  public constructor(cause?: unknown) {
    super(409, {
      cause,
      message: "Capture processing changed before import. Refresh the capture before trying again.",
    });
  }
}

export async function importReviewedCapture(
  input: CaptureImportInput,
): Promise<BottleImportResult> {
  const {
    captureId,
    database,
    runId,
    siteId,
    wineVintageId,
    workflowInstanceId,
    expectedReviewRevision,
  } = input;
  const committed = await getCommittedCaptureImport({ captureId, database, runId });
  if (committed !== null) return committed;
  const reviewReasons = candidateValidationReasons(input.candidate, input.quantity);
  if (reviewReasons.length > 0) {
    throw new HTTPException(400, { message: reviewReasons.join(" ") });
  }
  const validatedInput = validatedImportInput(input);
  // Manual preparation is read-only. The final batch validates the reviewed
  // snapshot and commits completion with inventory, without an intermediate claim.
  const claim = { captureId, runId, siteId, workflowInstanceId };
  const matchResult: BottleMatchResult =
    wineVintageId === undefined
      ? { kind: "create_new", wineryCandidates: [], wineVintageCandidates: [] }
      : {
          kind: "reuse_wine_vintage",
          wineryCandidates: [],
          wineVintageCandidate: { id: wineVintageId, label: wineVintageId },
          wineVintageCandidates: [],
        };
  return retryCatalogueTransaction(async () => {
    try {
      return await commitCaptureImport({
        input: validatedInput,
        claim,
        matchResult,
        wineVintageId,
        expectedReviewRevision,
      });
    } catch (error) {
      // A competing import or a lost commit acknowledgement may have completed
      // this capture. Its durable receipt is authoritative for every retry.
      const receipt = await getCommittedCaptureImport({ captureId, database, runId });
      if (receipt !== null) return receipt;
      throw error;
    }
  });
}

async function commitCaptureImport({
  input,
  claim,
  matchResult,
  wineVintageId,
  expectedReviewRevision,
}: {
  readonly input: CaptureImportInput;
  readonly claim: CaptureImportClaim;
  readonly matchResult: BottleMatchResult;
  readonly wineVintageId: string | undefined;
  readonly expectedReviewRevision: number;
}): Promise<BottleImportResult> {
  const { candidate, database, quantity, userId } = input;
  const { captureId, runId, siteId } = claim;
  const vintage =
    wineVintageId === undefined
      ? await prepareWineVintage({ database, siteId, wine: candidate.wine })
      : await getExistingVintage({ database, siteId, wineVintageId });
  const { bottleIds, statements } = createBottleStatements({
    bottleIds: bottleIdsForCapture({ captureId, quantity }),
    database,
    siteId,
    wineVintageId: vintage.wineVintageId,
    storageLocationId: null,
    positionHint: null,
    bottle: candidate.bottle,
    quantity,
  });
  const result = {
    kind: "imported",
    bottleIds,
    wineryId: vintage.wineryId,
    wineVintageId: vintage.wineVintageId,
    matchResult,
  } satisfies BottleImportResult;
  await assertExistingBottlesMatch({
    bottleIds,
    database,
    siteId,
    wineVintageId: vintage.wineVintageId,
  });
  try {
    await commitOperation({ database, userId, source: "http" }, siteId, [
      captureImportGuardStatement({
        claim,
        database,
        expectedReviewRevision,
        wineVintageId,
        bottleIds,
        targetWineVintageId: vintage.wineVintageId,
      }),
      ...importCompletionStatements({ captureId, database, result, runId }),
      ...vintage.statements,
      ...statements,
      // Read the destination in the transaction: deleting a location detaches
      // the capture, and must not restore its stale pre-preparation location.
      ...bottleIds.map((bottleId) =>
        database
          .insert(bottleLocations)
          .select(
            database
              .select({
                bottleId: sql<string>`${bottleId}`.as("bottle_id"),
                siteId: bottleCaptures.siteId,
                storageLocationId: sql<string>`${bottleCaptures.storageLocationId}`.as(
                  "storage_location_id",
                ),
                positionHint: bottleCaptures.positionHint,
                updatedAt: sql<string>`CURRENT_TIMESTAMP`.as("updated_at"),
              })
              .from(bottleCaptures)
              .where(
                and(
                  eq(bottleCaptures.id, captureId),
                  sql`${bottleCaptures.storageLocationId} IS NOT NULL`,
                ),
              ),
          )
          .onConflictDoNothing({ target: bottleLocations.bottleId }),
      ),
    ]);
  } catch (error) {
    if (isCaptureImportGuardFailure(error)) throw new CaptureImportConflictError(error);
    throw error;
  }
  return result;
}

function captureImportGuardStatement({
  claim,
  database,
  expectedReviewRevision,
  wineVintageId,
  bottleIds,
  targetWineVintageId,
}: {
  readonly claim: CaptureImportClaim;
  readonly database: BoozeDatabase;
  readonly expectedReviewRevision: number;
  readonly wineVintageId: string | undefined;
  readonly bottleIds: readonly string[];
  readonly targetWineVintageId: string;
}) {
  // D1 batches cannot branch on an UPDATE's affected-row count. This INSERT is
  // a no-op for an existing run with the current claim. A stale/missing claim
  // produces NULL capture_id: SQLite checks NOT NULL before the ID-conflict
  // no-op, aborting the entire batch before any receipt or inventory is written.
  return database
    .insert(bottleCaptureRuns)
    .values({
      id: claim.runId,
      captureId: sql`(SELECT ${bottleCaptures.id} FROM ${bottleCaptures}
        WHERE ${bottleCaptures.id} = ${claim.captureId}
          AND ${bottleCaptures.siteId} = ${claim.siteId}
          AND ${sql`${bottleCaptures.status} = 'needs_review' AND ${bottleCaptures.reviewRevision} = ${expectedReviewRevision}`}
          AND ${bottleCaptures.workflowInstanceId} IS ${claim.workflowInstanceId}
          AND ${latestCaptureRunId(claim.captureId)} = ${claim.runId}
          AND (${bottleCaptures.storageLocationId} IS NULL OR EXISTS (
            SELECT 1 FROM ${storageLocations}
            WHERE ${storageLocations.id} = ${bottleCaptures.storageLocationId}
              AND ${storageLocations.siteId} = ${claim.siteId}))
          AND ${
            wineVintageId === undefined
              ? sql`1`
              : sql`EXISTS (
            SELECT 1 FROM ${wineVintages} WHERE ${wineVintages.id} = ${wineVintageId}
              AND ${wineVintages.siteId} = ${claim.siteId})`
          }
          AND NOT EXISTS (SELECT 1 FROM ${bottles}
            WHERE ${inArray(bottles.id, [...bottleIds])}
              AND (${bottles.siteId} <> ${claim.siteId}
                OR ${bottles.wineVintageId} <> ${targetWineVintageId})))`,
      status: "importing",
      extractorVersion: "manual-review",
      promptVersion: "manual-review",
      schemaVersion: "wine-vintage-v2",
    })
    .onConflictDoNothing({ target: bottleCaptureRuns.id });
}

function isCaptureImportGuardFailure(error: unknown): boolean {
  const seen = new Set<Error>();
  let cause = error;
  while (cause instanceof Error && !seen.has(cause)) {
    seen.add(cause);
    if (
      /^(?:D1_ERROR: )?NOT NULL constraint failed: bottle_capture_runs\.capture_id(?:: SQLITE_CONSTRAINT(?: \(extended: SQLITE_CONSTRAINT_NOTNULL\))?)?$/u.test(
        cause.message,
      )
    ) {
      return true;
    }
    cause = cause.cause;
  }
  return false;
}

async function assertExistingBottlesMatch({
  bottleIds,
  database,
  siteId,
  wineVintageId,
}: {
  readonly bottleIds: readonly string[];
  readonly database: BoozeDatabase;
  readonly siteId: string;
  readonly wineVintageId: string;
}): Promise<void> {
  const existing = await database
    .select({ siteId: bottles.siteId, wineVintageId: bottles.wineVintageId })
    .from(bottles)
    .where(inArray(bottles.id, [...bottleIds]));
  if (
    existing.some((bottle) => bottle.siteId !== siteId || bottle.wineVintageId !== wineVintageId)
  ) {
    throw new Error(
      "Capture already contains bottles for a different wine. Review the existing bottles before importing.",
    );
  }
}

function importCompletionStatements({
  captureId,
  database,
  result,
  runId,
}: {
  readonly captureId: string;
  readonly database: BoozeDatabase;
  readonly result: BottleImportResult;
  readonly runId: string;
}) {
  return [
    database
      .update(bottleCaptureRuns)
      .set({
        status: "imported",
        importResultJson: JSON.stringify(result),
        matchResultJson: JSON.stringify(result.matchResult),
        errorMessage: null,
        completedAt: new Date().toISOString(),
      })
      .where(eq(bottleCaptureRuns.id, runId)),
    database
      .update(bottleCaptures)
      .set({
        status: "imported",
        importedBottleIdsJson: JSON.stringify(result.bottleIds),
        errorMessage: null,
        errorDetailJson: null,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(bottleCaptures.id, captureId)),
  ] as const;
}

export async function getCommittedCaptureImport({
  captureId,
  database,
  runId,
}: {
  readonly captureId: string;
  readonly database: BoozeDatabase;
  readonly runId: string;
}): Promise<BottleImportResult | null> {
  const [run] = await database
    .select({ result: bottleCaptureRuns.importResultJson })
    .from(bottleCaptureRuns)
    .where(
      and(
        eq(bottleCaptureRuns.id, runId),
        eq(bottleCaptureRuns.captureId, captureId),
        eq(bottleCaptureRuns.status, "imported"),
      ),
    )
    .limit(1);
  if (run?.result === null || run?.result === undefined) {
    return null;
  }
  // This receipt is written atomically with the bottles by importCompletionStatements.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Reads the internal persisted import result.
  return JSON.parse(run.result) as BottleImportResult;
}

function candidateValidationReasons(
  candidate: ImportCandidate,
  quantity?: number,
): readonly string[] {
  const reasons = (candidate.validationIssues ?? []).map(
    (issue) => `${issue.path}: ${issue.message} Label value: ${JSON.stringify(issue.rawValue)}.`,
  );
  const validated = catalogueCandidateSchema.safeParse(candidate);
  if (!validated.success) {
    reasons.push(
      ...validated.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    );
  }
  if (quantity !== undefined) {
    const validatedQuantity = bottleQuantitySchema.safeParse(quantity);
    if (!validatedQuantity.success)
      reasons.push("quantity: Enter a whole bottle quantity between 1 and 24.");
  }
  return reasons;
}

function validatedImportInput(input: CaptureImportInput): CaptureImportInput {
  return {
    ...input,
    candidate: { ...input.candidate, ...catalogueCandidateSchema.parse(input.candidate) },
    quantity: bottleQuantitySchema.parse(input.quantity),
  };
}

async function getExistingVintage({
  database,
  siteId,
  wineVintageId,
}: {
  readonly database: BoozeDatabase;
  readonly siteId: string;
  readonly wineVintageId: string;
}): Promise<{
  readonly wineryId: string | null;
  readonly wineVintageId: string;
  readonly statements: readonly never[];
}> {
  const rows = await database
    .select({ wineVintageId: wineVintages.id, wineryId: wineVintages.wineryId })
    .from(wineVintages)
    .where(and(eq(wineVintages.siteId, siteId), eq(wineVintages.id, wineVintageId)))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    throw new HTTPException(400, {
      message:
        "The selected wine is no longer available in this site. Refresh and choose another wine.",
    });
  }
  return { ...row, statements: [] };
}

export function databaseFromD1(database: D1Database): BoozeDatabase {
  return createD1Client(database);
}

function bottleIdsForCapture({
  captureId,
  quantity,
}: {
  readonly captureId: string;
  readonly quantity: number;
}): readonly string[] {
  return Array.from({ length: quantity }, (_, index) =>
    stableId("bottle", `${captureId}-${index}`),
  );
}
