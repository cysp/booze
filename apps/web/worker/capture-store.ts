import {
  bottleCaptureImages,
  bottleCaptureRuns,
  bottleCaptures,
  createD1Client,
  imageAssets,
  siteMemberships,
  sites,
  storageLocations,
  type BoozeDatabase,
} from "@chikachow/booze-db";
import { and, desc, eq, ne, sql, type SQL } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";

import type { CaptureReviewCandidate } from "../shared/capture-review.ts";
import { captureReviewCandidateResourceSchema } from "../shared/catalogue-resources.ts";
import { isCaptureStatus, type CaptureStatus } from "./capture-state.ts";

import type {
  CaptureImageResource,
  CaptureRunResource,
  CaptureResource,
} from "../shared/catalogue-resources.ts";
export type {
  CaptureImageResource,
  CaptureRunResource,
  CaptureResource,
} from "../shared/catalogue-resources.ts";

export type CaptureWorkflowRecord = {
  readonly id: string;
  readonly siteId: string;
  readonly userId: string;
  readonly storageLocationId: string | null;
  readonly positionHint: string | null;
  readonly quantity: number;
  readonly images: readonly {
    readonly imageAssetId: string;
    readonly r2Key: string;
    readonly contentType: string;
    readonly sortOrder: number;
  }[];
};

export async function listBottleCaptures({
  captureId,
  database,
  userId,
}: {
  readonly captureId?: string;
  readonly database: BoozeDatabase;
  readonly userId: string;
}): Promise<readonly CaptureResource[]> {
  const rows = await database
    .select({
      id: bottleCaptures.id,
      siteId: bottleCaptures.siteId,
      siteName: sites.name,
      storageLocationId: bottleCaptures.storageLocationId,
      storageLocationName: storageLocations.name,
      positionHint: bottleCaptures.positionHint,
      quantity: bottleCaptures.quantity,
      status: bottleCaptures.status,
      workflowInstanceId: bottleCaptures.workflowInstanceId,
      importedBottleIdsJson: bottleCaptures.importedBottleIdsJson,
      reviewCandidateJson: bottleCaptures.reviewCandidateJson,
      reviewRevision: bottleCaptures.reviewRevision,
      errorMessage: bottleCaptures.errorMessage,
      createdAt: bottleCaptures.createdAt,
      updatedAt: bottleCaptures.updatedAt,
    })
    .from(bottleCaptures)
    .innerJoin(sites, eq(bottleCaptures.siteId, sites.id))
    .innerJoin(siteMemberships, eq(bottleCaptures.siteId, siteMemberships.siteId))
    .leftJoin(
      storageLocations,
      and(
        eq(bottleCaptures.siteId, storageLocations.siteId),
        eq(bottleCaptures.storageLocationId, storageLocations.id),
      ),
    )
    .where(
      and(
        eq(siteMemberships.userId, userId),
        captureId === undefined ? undefined : eq(bottleCaptures.id, captureId),
      ),
    )
    .orderBy(desc(bottleCaptures.createdAt));

  if (rows.length === 0) return [];
  const [imagesByCapture, runsByCapture] = await Promise.all([
    listCaptureImages({ database, userId, captureId }),
    listLatestRuns({ database, userId, captureId }),
  ]);
  return rows.map((row) => ({
    ...row,
    status: captureStatus(row.status),
    importedBottleIds: parseStringArray(row.importedBottleIdsJson),
    reviewCandidate:
      row.reviewCandidateJson === null
        ? null
        : captureReviewCandidateResourceSchema.parse(parseJson(row.reviewCandidateJson)),
    images: imagesByCapture.get(row.id) ?? [],
    latestRun: runsByCapture.get(row.id) ?? null,
  }));
}

export async function getBottleCapture({
  captureId,
  database,
  userId,
}: {
  readonly captureId: string;
  readonly database: BoozeDatabase;
  readonly userId: string;
}): Promise<CaptureResource> {
  const rows = await listBottleCaptures({ captureId, database, userId });
  const capture = rows.find((row) => row.id === captureId);
  if (capture === undefined) {
    throw new HTTPException(404, { message: "Capture not found" });
  }
  return capture;
}

export async function getCaptureForWorkflow({
  captureId,
  database,
}: {
  readonly captureId: string;
  readonly database: BoozeDatabase;
}): Promise<CaptureWorkflowRecord> {
  const captures = await database
    .select({
      id: bottleCaptures.id,
      siteId: bottleCaptures.siteId,
      userId: bottleCaptures.userId,
      storageLocationId: bottleCaptures.storageLocationId,
      positionHint: bottleCaptures.positionHint,
      quantity: bottleCaptures.quantity,
    })
    .from(bottleCaptures)
    .where(eq(bottleCaptures.id, captureId))
    .limit(1);
  const capture = captures[0];
  if (capture === undefined) {
    throw new Error(`Capture ${captureId} not found`);
  }

  const images = await database
    .select({
      imageAssetId: imageAssets.id,
      r2Key: imageAssets.r2Key,
      contentType: imageAssets.contentType,
      sortOrder: bottleCaptureImages.sortOrder,
    })
    .from(bottleCaptureImages)
    .innerJoin(imageAssets, eq(bottleCaptureImages.imageAssetId, imageAssets.id))
    .where(eq(bottleCaptureImages.captureId, captureId))
    .orderBy(bottleCaptureImages.sortOrder);

  return { ...capture, images };
}

export async function getCaptureImageObject({
  captureId,
  database,
  imageAssetId,
  original = false,
  userId,
}: {
  readonly captureId: string;
  readonly database: BoozeDatabase;
  readonly imageAssetId: string;
  readonly original?: boolean;
  readonly userId: string;
}): Promise<{
  readonly r2Key: string;
  readonly contentType: string;
  readonly needsThumbnail: boolean;
}> {
  const rows = await database
    .select({
      r2Key: original
        ? imageAssets.r2Key
        : sql<string>`coalesce(${imageAssets.thumbnailR2Key}, ${imageAssets.r2Key})`,
      contentType: original
        ? imageAssets.contentType
        : sql<string>`coalesce(${imageAssets.thumbnailContentType}, ${imageAssets.contentType})`,
      needsThumbnail: (original
        ? sql<boolean>`0`
        : sql<boolean>`${imageAssets.thumbnailR2Key} IS NULL`
      ).mapWith(Boolean),
    })
    .from(bottleCaptureImages)
    .innerJoin(imageAssets, eq(bottleCaptureImages.imageAssetId, imageAssets.id))
    .innerJoin(bottleCaptures, eq(bottleCaptureImages.captureId, bottleCaptures.id))
    .innerJoin(siteMemberships, eq(bottleCaptures.siteId, siteMemberships.siteId))
    .where(
      and(
        eq(bottleCaptureImages.captureId, captureId),
        eq(bottleCaptureImages.imageAssetId, imageAssetId),
        eq(siteMemberships.userId, userId),
      ),
    )
    .limit(1);
  const image = rows[0];
  if (image === undefined) {
    throw new HTTPException(404, { message: "Capture image not found" });
  }
  return image;
}

export async function createCaptureRun({
  captureId,
  database,
  runId = crypto.randomUUID(),
  status,
}: {
  readonly captureId: string;
  readonly database: BoozeDatabase;
  readonly runId?: string;
  readonly status: string;
}): Promise<{ readonly runId: string; readonly attemptNumber: number }> {
  const previousRuns = await database
    .select({ id: bottleCaptureRuns.id })
    .from(bottleCaptureRuns)
    .where(eq(bottleCaptureRuns.captureId, captureId));
  const attemptNumber = previousRuns.length + 1;
  await database
    .insert(bottleCaptureRuns)
    .values({
      id: runId,
      captureId,
      status,
      extractorVersion: "bottle-ocr-v1",
      promptVersion: "capture-v1",
      schemaVersion: "wine-vintage-v1",
      attemptNumber,
      startedAt: new Date().toISOString(),
    })
    .onConflictDoNothing({ target: bottleCaptureRuns.id });
  return { runId, attemptNumber };
}

export async function updateCaptureStatus({
  captureId,
  database,
  errorDetail,
  errorMessage,
  importedBottleIds,
  status,
  workflowInstanceId,
  expectedStatus,
  runId,
}: {
  readonly captureId: string;
  readonly database: BoozeDatabase;
  readonly errorDetail?: unknown;
  readonly errorMessage?: string | null;
  readonly importedBottleIds?: readonly string[];
  readonly status: CaptureStatus;
  readonly workflowInstanceId?: string | null | undefined;
  readonly expectedStatus?: CaptureStatus;
  readonly runId?: string;
}): Promise<void> {
  await database
    .update(bottleCaptures)
    .set({
      status,
      ...(errorMessage === undefined ? {} : { errorMessage }),
      ...(errorDetail === undefined
        ? {}
        : { errorDetailJson: errorDetail === null ? null : JSON.stringify(errorDetail) }),
      ...(importedBottleIds === undefined
        ? {}
        : { importedBottleIdsJson: JSON.stringify(importedBottleIds) }),
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(
      and(
        eq(bottleCaptures.id, captureId),
        status === "imported" ? undefined : ne(bottleCaptures.status, "imported"),
        workflowInstanceId === undefined
          ? undefined
          : sql`${bottleCaptures.workflowInstanceId} IS ${workflowInstanceId}`,
        expectedStatus === undefined ? undefined : eq(bottleCaptures.status, expectedStatus),
        runId === undefined ? undefined : eq(latestCaptureRunId(captureId), runId),
      ),
    );
}

export async function saveCaptureReview({
  captureId,
  database,
  candidate,
  expectedRevision,
}: {
  readonly captureId: string;
  readonly database: BoozeDatabase;
  readonly candidate: CaptureReviewCandidate;
  readonly expectedRevision: number;
}): Promise<number> {
  const [saved] = await database
    .update(bottleCaptures)
    .set({
      reviewCandidateJson: JSON.stringify(candidate),
      reviewRevision: sql`${bottleCaptures.reviewRevision} + 1`,
      status: "needs_review",
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(
      and(
        eq(bottleCaptures.id, captureId),
        eq(bottleCaptures.reviewRevision, expectedRevision),
        sql`${bottleCaptures.status} IN ('failed', 'needs_review')`,
      ),
    )
    .returning({ revision: bottleCaptures.reviewRevision });
  if (saved === undefined)
    throw new HTTPException(409, {
      message:
        "Capture processing or saved corrections changed. Refresh before saving your corrections again.",
    });
  return saved.revision;
}

export async function ensureManualCaptureRun({
  captureId,
  database,
  expectedReviewRevision,
}: {
  readonly captureId: string;
  readonly database: BoozeDatabase;
  readonly expectedReviewRevision: number;
}): Promise<string> {
  const runId = `manual_${captureId}`;
  await database.run(sql`INSERT INTO bottle_capture_runs
    (id, capture_id, status, extractor_version, prompt_version, schema_version, attempt_number)
    SELECT ${runId}, id, 'needs_review', 'manual-review', 'manual-review', 'wine-vintage-v2', 1
    FROM ${bottleCaptures} WHERE id = ${captureId}
      AND status = 'needs_review' AND review_revision = ${expectedReviewRevision}
      AND review_candidate_json IS NOT NULL
      AND ${latestCaptureRunId(captureId)} IS NULL
    ON CONFLICT(id) DO NOTHING`);
  return runId;
}

export async function reserveCaptureRetry({
  captureId,
  database,
  workflowInstanceId,
}: {
  readonly captureId: string;
  readonly database: BoozeDatabase;
  readonly workflowInstanceId: string;
}): Promise<boolean> {
  const result = await database.run(sql`UPDATE ${bottleCaptures}
    SET status = 'queued', workflow_instance_id = ${workflowInstanceId},
        error_message = NULL, error_detail_json = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = ${captureId} AND status IN ('failed', 'needs_review')`);
  return result.meta.changes === 1;
}

export async function beginCaptureWorkflow({
  captureId,
  database,
  workflowInstanceId,
}: {
  readonly captureId: string;
  readonly database: BoozeDatabase;
  readonly workflowInstanceId: string;
}): Promise<boolean> {
  const result = await database.run(sql`UPDATE ${bottleCaptures}
    SET status = 'extracting', error_message = NULL, error_detail_json = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${captureId} AND workflow_instance_id = ${workflowInstanceId}
      AND status IN ('queued', 'extracting', 'importing', 'failed', 'needs_review')`);
  return result.meta.changes === 1;
}

export type CaptureImportClaim = {
  readonly captureId: string;
  readonly runId: string;
  readonly siteId: string;
  readonly workflowInstanceId: string | null;
};

export async function claimCaptureForImport({
  captureId,
  database,
  runId,
  siteId,
  workflowInstanceId,
}: {
  readonly captureId: string;
  readonly database: BoozeDatabase;
  readonly runId: string;
  readonly siteId: string;
  readonly workflowInstanceId?: string | null | undefined;
}): Promise<CaptureImportClaim | null> {
  const [claim] = await database
    .update(bottleCaptures)
    .set({ status: "importing", updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(
      and(
        eq(bottleCaptures.id, captureId),
        eq(bottleCaptures.siteId, siteId),
        eq(latestCaptureRunId(captureId), runId),
        sql`${bottleCaptures.reviewCandidateJson} IS NULL`,
        sql`${bottleCaptures.status} IN ('extracting', 'importing')`,
        // Historical captures without a Workflow ID have a NULL owner; omission
        // must not bypass ownership for automatic imports.
        sql`${bottleCaptures.workflowInstanceId} IS ${workflowInstanceId ?? null}`,
      ),
    )
    .returning({
      captureId: bottleCaptures.id,
      siteId: bottleCaptures.siteId,
      workflowInstanceId: bottleCaptures.workflowInstanceId,
    });
  return claim === undefined ? null : { ...claim, runId };
}

export function latestCaptureRunId(captureId: string | typeof bottleCaptures.id): SQL<string> {
  return sql<string>`(SELECT latest.id FROM bottle_capture_runs AS latest
    WHERE latest.capture_id = ${captureId}
    ORDER BY latest.attempt_number DESC, latest.created_at DESC, latest.id DESC LIMIT 1)`;
}

export async function updateCaptureRun({
  database,
  errorDetailArtifact,
  errorMessage,
  extractionArtifact,
  importCandidate,
  importResult,
  matchResult,
  model,
  runId,
  status,
}: {
  readonly database: BoozeDatabase;
  readonly errorDetailArtifact?:
    | {
        readonly contentType: string;
        readonly r2Key: string;
        readonly sizeBytes: number;
      }
    | undefined;
  readonly errorMessage?: string | null;
  readonly extractionArtifact?:
    | {
        readonly contentType: string;
        readonly r2Key: string;
        readonly sizeBytes: number;
      }
    | undefined;
  readonly importCandidate?: unknown;
  readonly importResult?: unknown;
  readonly matchResult?: unknown;
  readonly model?: string | null;
  readonly runId: string;
  readonly status: string;
}): Promise<void> {
  await database
    .update(bottleCaptureRuns)
    .set({
      status,
      ...(extractionArtifact === undefined
        ? {}
        : {
            extractionR2Key: extractionArtifact.r2Key,
            extractionContentType: extractionArtifact.contentType,
            extractionSizeBytes: extractionArtifact.sizeBytes,
          }),
      ...(importCandidate === undefined
        ? {}
        : {
            importCandidateJson: JSON.stringify(importCandidate),
          }),
      ...(matchResult === undefined ? {} : { matchResultJson: JSON.stringify(matchResult) }),
      ...(importResult === undefined ? {} : { importResultJson: JSON.stringify(importResult) }),
      ...(model === undefined ? {} : { model }),
      ...(errorMessage === undefined ? {} : { errorMessage }),
      ...(errorDetailArtifact === undefined
        ? {}
        : {
            errorDetailR2Key: errorDetailArtifact.r2Key,
            errorDetailContentType: errorDetailArtifact.contentType,
            errorDetailSizeBytes: errorDetailArtifact.sizeBytes,
          }),
      completedAt: ["imported", "failed", "needs_review", "skipped"].includes(status)
        ? new Date().toISOString()
        : null,
    })
    .where(
      and(
        eq(bottleCaptureRuns.id, runId),
        status === "imported" ? undefined : ne(bottleCaptureRuns.status, "imported"),
      ),
    );
}

async function listCaptureImages({
  captureId,
  database,
  userId,
}: {
  readonly captureId: string | undefined;
  readonly database: BoozeDatabase;
  readonly userId: string;
}): Promise<ReadonlyMap<string, readonly CaptureImageResource[]>> {
  const rows = await database
    .select({
      captureId: bottleCaptureImages.captureId,
      imageAssetId: imageAssets.id,
      originalFilename: bottleCaptureImages.originalFilename,
      sortOrder: bottleCaptureImages.sortOrder,
      contentType: sql<string>`coalesce(${imageAssets.thumbnailContentType}, ${imageAssets.contentType})`,
      sizeBytes: sql<number>`coalesce(${imageAssets.thumbnailSizeBytes}, ${imageAssets.sizeBytes})`,
    })
    .from(bottleCaptureImages)
    .innerJoin(imageAssets, eq(bottleCaptureImages.imageAssetId, imageAssets.id))
    .innerJoin(bottleCaptures, eq(bottleCaptureImages.captureId, bottleCaptures.id))
    .innerJoin(siteMemberships, eq(bottleCaptures.siteId, siteMemberships.siteId))
    .where(
      and(
        eq(siteMemberships.userId, userId),
        captureId === undefined ? undefined : eq(bottleCaptures.id, captureId),
      ),
    )
    .orderBy(bottleCaptureImages.sortOrder);

  const imagesByCapture = new Map<string, CaptureImageResource[]>();
  for (const { captureId: rowCaptureId, ...image } of rows) {
    const images = imagesByCapture.get(rowCaptureId) ?? [];
    images.push({
      ...image,
      imageUrl: `/api/bottle-captures/${encodeURIComponent(rowCaptureId)}/images/${encodeURIComponent(image.imageAssetId)}`,
    });
    imagesByCapture.set(rowCaptureId, images);
  }
  return imagesByCapture;
}

async function listLatestRuns({
  captureId,
  database,
  userId,
}: {
  readonly captureId: string | undefined;
  readonly database: BoozeDatabase;
  readonly userId: string;
}): Promise<ReadonlyMap<string, CaptureRunResource>> {
  const rows = await database
    .select({
      captureId: bottleCaptureRuns.captureId,
      id: bottleCaptureRuns.id,
      status: bottleCaptureRuns.status,
      extractionR2Key: bottleCaptureRuns.extractionR2Key,
      extractionContentType: bottleCaptureRuns.extractionContentType,
      extractionSizeBytes: bottleCaptureRuns.extractionSizeBytes,
      importCandidateJson: bottleCaptureRuns.importCandidateJson,
      matchResultJson: bottleCaptureRuns.matchResultJson,
      importResultJson: bottleCaptureRuns.importResultJson,
      errorMessage: bottleCaptureRuns.errorMessage,
      errorDetailR2Key: bottleCaptureRuns.errorDetailR2Key,
      errorDetailContentType: bottleCaptureRuns.errorDetailContentType,
      errorDetailSizeBytes: bottleCaptureRuns.errorDetailSizeBytes,
      createdAt: bottleCaptureRuns.createdAt,
      completedAt: bottleCaptureRuns.completedAt,
    })
    .from(bottleCaptureRuns)
    .innerJoin(bottleCaptures, eq(bottleCaptureRuns.captureId, bottleCaptures.id))
    .innerJoin(siteMemberships, eq(bottleCaptures.siteId, siteMemberships.siteId))
    .where(
      and(
        eq(siteMemberships.userId, userId),
        captureId === undefined ? undefined : eq(bottleCaptures.id, captureId),
        eq(bottleCaptureRuns.id, latestCaptureRunId(bottleCaptures.id)),
      ),
    );
  return new Map(
    rows.map((row) => [
      row.captureId,
      {
        id: row.id,
        status: row.status,
        extractionR2Key: row.extractionR2Key,
        extractionContentType: row.extractionContentType,
        extractionSizeBytes: row.extractionSizeBytes,
        importCandidate: parseJson(row.importCandidateJson),
        matchResult: parseJson(row.matchResultJson),
        importResult: parseJson(row.importResultJson),
        errorMessage: row.errorMessage,
        errorDetailR2Key: row.errorDetailR2Key,
        errorDetailContentType: row.errorDetailContentType,
        errorDetailSizeBytes: row.errorDetailSizeBytes,
        createdAt: row.createdAt,
        completedAt: row.completedAt,
      },
    ]),
  );
}

function captureStatus(value: string): CaptureStatus {
  return isCaptureStatus(value) ? value : "failed";
}

function parseStringArray(value: string | null): readonly string[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter((entry): entry is string => typeof entry === "string");
}

function parseJson(value: string | null): unknown {
  if (value === null) {
    return null;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

export function captureDatabaseFromEnv(database: D1Database): BoozeDatabase {
  return createD1Client(database);
}
