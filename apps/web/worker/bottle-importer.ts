// oxlint-disable import/max-dependencies -- Capture import coordinates candidate validation, matching, ownership, and atomic inventory completion.
import { storedVintageLabel, storedVintageStatus } from "./api/wine-vintage.ts";
import {
  bottleCaptureRuns,
  bottleCaptures,
  bottleLocations,
  bottles,
  storageLocations,
  createD1Client,
  wineries,
  wineVintages,
  type BoozeDatabase,
} from "@chikachow/booze-db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";

import { createBottleStatements, prepareWineVintage } from "./api/catalogue.ts";
import { stableId } from "./api/ids.ts";
import { retryCatalogueTransaction } from "./api/catalogue-transaction.ts";
import { hasWineIdentity, wineVintageStatus } from "../shared/wine-identity.ts";
import { bottleQuantitySchema, catalogueCandidateSchema } from "../shared/catalogue-inputs.ts";
import type { ImportCandidate } from "./bottle-extractor.ts";
import {
  claimCaptureForImport,
  latestCaptureRunId,
  type CaptureImportClaim,
} from "./capture-store.ts";

export type ImportReviewReason =
  | "ambiguous_winery"
  | "ambiguous_wine_vintage"
  | "invalid_candidate"
  | "missing_required_candidate"
  | "possible_existing_wine"
  | "saved_manual_corrections";

export type BottleImportResult =
  | {
      readonly kind: "imported";
      readonly bottleIds: readonly string[];
      readonly wineVintageId: string;
      readonly wineryId: string | null;
      readonly matchResult: BottleMatchResult;
    }
  | {
      readonly kind: "skipped";
      readonly reason: "capture_import_already_claimed";
      readonly matchResult: BottleMatchResult;
    }
  | {
      readonly kind: "needs_review";
      readonly reason: ImportReviewReason;
      readonly matchResult: BottleMatchResult;
      readonly reviewReasons?: readonly string[];
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
    }
  | {
      readonly kind: "needs_review";
      readonly reason: ImportReviewReason;
      readonly wineryCandidates: readonly MatchCandidate[];
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
  readonly siteId: string;
  readonly runId: string;
  readonly workflowInstanceId?: string | null | undefined;
};

export class CaptureImportConflictError extends HTTPException {
  public constructor(cause?: unknown) {
    super(409, {
      cause,
      message: "Capture processing changed before import. Refresh the capture before trying again.",
    });
  }
}

export async function importBottleCandidate(
  input: CaptureImportInput,
): Promise<BottleImportResult> {
  const { candidate, captureId, database, runId, siteId, workflowInstanceId } = input;
  return retryCatalogueTransaction(async (): Promise<BottleImportResult> => {
    const committed = await getCommittedCaptureImport({ captureId, database, runId });
    if (committed !== null) {
      return committed;
    }
    const reviewReasons = candidateValidationReasons(candidate, input.quantity);
    if (reviewReasons.length > 0) {
      return {
        kind: "needs_review",
        reason: "invalid_candidate",
        reviewReasons,
        matchResult: invalidCandidateMatch(),
      };
    }
    const validatedInput = validatedImportInput(input);
    const [captureReview] = await database
      .select({ candidate: bottleCaptures.reviewCandidateJson })
      .from(bottleCaptures)
      .where(eq(bottleCaptures.id, captureId))
      .limit(1);
    if (captureReview !== undefined && captureReview.candidate !== null) {
      const matchResult = {
        kind: "needs_review",
        reason: "saved_manual_corrections",
        wineryCandidates: [],
        wineVintageCandidates: [],
      } as const;
      return { kind: "needs_review", reason: "saved_manual_corrections", matchResult };
    }
    const matchResult = await matchBottleCandidate({
      candidate: validatedInput.candidate,
      database,
      siteId,
    });
    if (matchResult.kind === "needs_review") {
      return {
        kind: "needs_review",
        reason: matchResult.reason,
        matchResult,
      };
    }

    const claim = await claimCaptureForImport({
      captureId,
      database,
      runId,
      siteId,
      workflowInstanceId,
    });
    const skipped = {
      kind: "skipped",
      reason: "capture_import_already_claimed",
      matchResult,
    } satisfies BottleImportResult;
    if (claim === null) return skipped;
    try {
      return await commitCaptureImport({
        input: validatedInput,
        claim,
        matchResult,
        wineVintageId:
          matchResult.kind === "reuse_wine_vintage"
            ? matchResult.wineVintageCandidate.id
            : undefined,
      });
    } catch (error) {
      if (!(error instanceof CaptureImportConflictError)) throw error;
      return (await getCommittedCaptureImport({ captureId, database, runId })) ?? skipped;
    }
  });
}

export async function importReviewedCapture(
  input: CaptureImportInput & {
    readonly wineVintageId?: string | undefined;
    readonly workflowInstanceId: string | null;
    readonly expectedReviewRevision: number;
  },
): Promise<Extract<BottleImportResult, { readonly kind: "imported" }>> {
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
  readonly expectedReviewRevision?: number;
}): Promise<Extract<BottleImportResult, { readonly kind: "imported" }>> {
  const { candidate, database, quantity } = input;
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
  } satisfies Extract<BottleImportResult, { readonly kind: "imported" }>;
  await assertExistingBottlesMatch({
    bottleIds,
    database,
    siteId,
    wineVintageId: vintage.wineVintageId,
  });
  try {
    await database.batch([
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
  readonly expectedReviewRevision: number | undefined;
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
          AND ${
            expectedReviewRevision === undefined
              ? sql`${bottleCaptures.status} = 'importing' AND ${bottleCaptures.reviewCandidateJson} IS NULL`
              : sql`${bottleCaptures.status} = 'needs_review' AND ${bottleCaptures.reviewRevision} = ${expectedReviewRevision}`
          }
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
      extractorVersion: "bottle-ocr-v1",
      promptVersion: "capture-v1",
      schemaVersion: "wine-vintage-v1",
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
  readonly result: Extract<BottleImportResult, { readonly kind: "imported" }>;
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
}): Promise<Extract<BottleImportResult, { readonly kind: "imported" }> | null> {
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
  return JSON.parse(run.result) as Extract<BottleImportResult, { readonly kind: "imported" }>;
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

function invalidCandidateMatch(): BottleMatchResult {
  return {
    kind: "needs_review",
    reason: "invalid_candidate",
    wineryCandidates: [],
    wineVintageCandidates: [],
  };
}

export async function matchBottleCandidate({
  candidate: inputCandidate,
  database,
  siteId,
}: {
  readonly candidate: ImportCandidate;
  readonly database: BoozeDatabase;
  readonly siteId: string;
}): Promise<BottleMatchResult> {
  if (candidateValidationReasons(inputCandidate).length > 0) return invalidCandidateMatch();
  const candidate = { ...inputCandidate, ...catalogueCandidateSchema.parse(inputCandidate) };
  if (
    !hasWineIdentity(candidate.wine) ||
    normalize(candidate.wine.wineryName || candidate.wine.brandName) === ""
  ) {
    return {
      kind: "needs_review",
      reason: "missing_required_candidate",
      wineryCandidates: [],
      wineVintageCandidates: [],
    };
  }

  const wineryRows = await database
    .select({ id: wineries.id, name: wineries.name, region: wineries.region })
    .from(wineries)
    .where(eq(wineries.siteId, siteId));
  const wineryCandidates = wineryRows
    .filter(
      (winery) =>
        normalize(winery.name) === normalize(candidate.wine.wineryName || candidate.wine.brandName),
    )
    .map((winery) => ({
      id: winery.id,
      label: winery.region === null ? winery.name : `${winery.name} (${winery.region})`,
    }));
  const wineVintageCandidates = await findWineVintageCandidates({ candidate, database, siteId });
  if (wineryCandidates.length > 1) {
    return {
      kind: "needs_review",
      reason: "ambiguous_winery",
      wineryCandidates,
      wineVintageCandidates,
    };
  }
  if (wineVintageCandidates.length > 1) {
    return {
      kind: "needs_review",
      reason: "ambiguous_wine_vintage",
      wineryCandidates,
      wineVintageCandidates,
    };
  }
  const wineVintageCandidate = wineVintageCandidates[0];
  if (wineVintageCandidate !== undefined) {
    return {
      kind: "needs_review",
      reason: "possible_existing_wine",
      wineryCandidates,
      wineVintageCandidates,
    };
  }
  return {
    kind: "create_new",
    wineryCandidates,
    wineVintageCandidates,
  };
}

async function findWineVintageCandidates({
  candidate,
  database,
  siteId,
}: {
  readonly candidate: ImportCandidate;
  readonly database: BoozeDatabase;
  readonly siteId: string;
}): Promise<readonly MatchCandidate[]> {
  const vintageStatus = wineVintageStatus(candidate.wine);
  const rows = await database
    .select({
      id: wineVintages.id,
      displayName: wineVintages.displayName,
      vintageYear: wineVintages.vintageYear,
      vintageStatus: storedVintageStatus,
      vintageLabel: storedVintageLabel,
      wineryName: wineries.name,
      brandName: wineVintages.brandName,
    })
    .from(wineVintages)
    .leftJoin(wineries, and(eq(wineries.id, wineVintages.wineryId), eq(wineries.siteId, siteId)))
    .where(eq(wineVintages.siteId, siteId));

  const names = [candidate.wine.wineryName, candidate.wine.brandName]
    .map((name) => normalize(name))
    .filter(Boolean);
  return (
    rows
      .filter((wine) =>
        [wine.wineryName, wine.brandName].some((name) => names.includes(normalize(name))),
      )
      // Descriptions are incomplete evidence, not identity. Within one producer,
      // an unknown vintage remains a possible match for any vintage. Even one
      // plausible existing record needs an explicit human reuse decision.
      .filter(
        (wine) =>
          vintageStatus === "unknown" ||
          wine.vintageStatus === "unknown" ||
          (vintageStatus === wine.vintageStatus &&
            (vintageStatus !== "year" || wine.vintageYear === candidate.wine.vintageYear)),
      )
      .map((wine) => ({
        id: wine.id,
        label: `${wine.vintageLabel} ${wine.displayName}`,
      }))
  );
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

function normalize(value: string | null | undefined): string {
  return (
    value
      ?.normalize("NFKD")
      .replaceAll(/\p{M}+/gu, "")
      .toLowerCase()
      .replaceAll("&", "and")
      .replaceAll(/[^\p{L}\p{N}]+/gu, " ")
      .replaceAll(/\b(wines?|winery|estate|vineyards?)\b/gu, "")
      .replaceAll(/\s+/gu, " ")
      .trim() ?? ""
  );
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
