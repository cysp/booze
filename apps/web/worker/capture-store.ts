// oxlint-disable import/max-dependencies -- Capture persistence owns bounded read projections and guarded lifecycle mutations.
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
import { and, asc, desc, eq, gt, inArray, lt, ne, or, sql, type SQL } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import { commitOperation } from "./operation-transaction.ts";

import type { CaptureReviewCandidate } from "../shared/capture-review.ts";
import { captureReviewCandidateResourceSchema } from "../shared/capture-resources.ts";
import {
  captureListQuerySchema,
  captureStatusQuerySchema,
  type CaptureListQuery,
} from "./capture-query-inputs.ts";
import type {
  CaptureCounts,
  CapturePage,
  CaptureStatusSnapshot,
} from "../shared/capture-read-resources.ts";
import {
  isCaptureStatus,
  processingCaptureStatuses,
  type CaptureStatus,
} from "../shared/capture-status.ts";
import { pageFromRows, readPaginationCursor } from "./read-pagination.ts";

import type {
  CaptureImageResource,
  CaptureRunResource,
  CaptureResource,
} from "../shared/capture-resources.ts";
export type {
  CaptureImageResource,
  CaptureRunResource,
  CaptureResource,
} from "../shared/capture-resources.ts";

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
  database,
  query = captureListQuerySchema.parse({}),
  userId,
}: {
  readonly database: BoozeDatabase;
  readonly query?: CaptureListQuery;
  readonly userId: string;
}): Promise<CapturePage> {
  const input = { ...captureListQuerySchema.parse(query), userId };
  const cursor = readPaginationCursor({
    cursorSchema: z.strictObject({ createdAt: z.string(), id: z.string() }),
    input,
    toolName: "bottle-captures",
  });
  const summaryQuery = database
    .select({
      id: bottleCaptures.id,
      siteId: bottleCaptures.siteId,
      siteName: sql<string>`${sites.name}`.as("site_name"),
      storageLocationId: bottleCaptures.storageLocationId,
      storageLocationName: sql<string | null>`${storageLocations.name}`.as("storage_location_name"),
      positionHint: bottleCaptures.positionHint,
      quantity: bottleCaptures.quantity,
      status: bottleCaptures.status,
      errorMessage: bottleCaptures.errorMessage,
      createdAt: bottleCaptures.createdAt,
      updatedAt: bottleCaptures.updatedAt,
      imageCount: sql<number>`(SELECT count(*) FROM ${bottleCaptureImages}
        WHERE ${bottleCaptureImages.captureId} = ${bottleCaptures.id})`
        .mapWith(Number)
        .as("image_count"),
      previewImageAssetId: sql<string | null>`(SELECT ${bottleCaptureImages.imageAssetId}
        FROM ${bottleCaptureImages}
        WHERE ${bottleCaptureImages.captureId} = ${bottleCaptures.id}
        ORDER BY ${bottleCaptureImages.sortOrder} LIMIT 1)`.as("preview_image_asset_id"),
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
        input.view === "action" ? ne(bottleCaptures.status, "imported") : undefined,
        cursor === null
          ? undefined
          : or(
              lt(bottleCaptures.createdAt, cursor.createdAt),
              and(eq(bottleCaptures.createdAt, cursor.createdAt), gt(bottleCaptures.id, cursor.id)),
            ),
      ),
    )
    .orderBy(desc(bottleCaptures.createdAt), asc(bottleCaptures.id))
    .limit(input.limit + 1);
  const [countRows, rows] = await database.batch([
    captureCountsQuery({ database, userId }),
    summaryQuery,
  ]);
  const counts = captureCounts(countRows[0]);
  const page = pageFromRows({
    cursorForItem: (row) => ({ createdAt: row.createdAt, id: row.id }),
    input,
    items: rows,
    toolName: "bottle-captures",
  });
  return {
    data: page.items.map(({ previewImageAssetId, ...row }) => ({
      ...row,
      status: captureStatus(row.status),
      previewImage:
        previewImageAssetId === null
          ? null
          : {
              imageAssetId: previewImageAssetId,
              imageUrl: captureImageUrl(row.id, previewImageAssetId),
            },
    })),
    totalCount:
      counts.actionable + counts.processing + (input.view === "all" ? counts.imported : 0),
    nextPageToken: page.metadata.nextPageToken,
    counts,
  };
}

export async function getCaptureCounts({
  database,
  userId,
}: {
  readonly database: BoozeDatabase;
  readonly userId: string;
}): Promise<CaptureCounts> {
  const rows = await captureCountsQuery({ database, userId });
  return captureCounts(rows[0]);
}

function captureCountsQuery({
  database,
  userId,
}: {
  readonly database: BoozeDatabase;
  readonly userId: string;
}) {
  return database
    .select({
      totalCount: sql<number>`count(*)`.mapWith(Number),
      processing:
        sql<number>`coalesce(sum(CASE WHEN ${inArray(bottleCaptures.status, processingCaptureStatuses)} THEN 1 ELSE 0 END), 0)`.mapWith(
          Number,
        ),
      imported:
        sql<number>`coalesce(sum(CASE WHEN ${bottleCaptures.status} = 'imported' THEN 1 ELSE 0 END), 0)`.mapWith(
          Number,
        ),
    })
    .from(bottleCaptures)
    .innerJoin(siteMemberships, eq(bottleCaptures.siteId, siteMemberships.siteId))
    .where(eq(siteMemberships.userId, userId));
}

function captureCounts(
  row:
    | { readonly totalCount: number; readonly processing: number; readonly imported: number }
    | undefined,
): CaptureCounts {
  const { totalCount = 0, processing = 0, imported = 0 } = row ?? {};
  // Historical unknown statuses read as failed, so include them in action counts.
  return { actionable: totalCount - processing - imported, processing, imported };
}

export async function listBottleCaptureStatuses({
  captureIds,
  database,
  userId,
}: {
  readonly captureIds: readonly string[];
  readonly database: BoozeDatabase;
  readonly userId: string;
}): Promise<readonly CaptureStatusSnapshot[]> {
  const input = captureStatusQuerySchema.parse({ captureIds });
  const rows = await database
    .select({
      id: bottleCaptures.id,
      status: bottleCaptures.status,
      updatedAt: bottleCaptures.updatedAt,
      errorMessage: bottleCaptures.errorMessage,
    })
    .from(bottleCaptures)
    .innerJoin(siteMemberships, eq(bottleCaptures.siteId, siteMemberships.siteId))
    .where(
      and(
        eq(siteMemberships.userId, userId),
        // One JSON parameter keeps 100 tracked IDs below D1's 100-parameter limit.
        sql`${bottleCaptures.id} IN (SELECT value FROM json_each(${JSON.stringify(input.captureIds)}))`,
      ),
    )
    .orderBy(asc(bottleCaptures.id));
  return rows.map((row) => ({ ...row, status: captureStatus(row.status) }));
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
    .where(and(eq(siteMemberships.userId, userId), eq(bottleCaptures.id, captureId)))
    .limit(1);

  const row = rows[0];
  if (row === undefined) {
    throw new HTTPException(404, { message: "Capture not found" });
  }
  const [imagesByCapture, runsByCapture] = await Promise.all([
    listCaptureImages({ database, userId, captureId }),
    listLatestRuns({ database, userId, captureId }),
  ]);
  const { importedBottleIdsJson, reviewCandidateJson, ...capture } = row;
  return {
    ...capture,
    status: captureStatus(row.status),
    importedBottleIds: parseStringArray(importedBottleIdsJson),
    reviewCandidate: parseStoredCaptureReviewCandidate(reviewCandidateJson),
    images: imagesByCapture.get(row.id) ?? [],
    latestRun: runsByCapture.get(row.id) ?? null,
  };
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
  workflowInstanceId,
}: {
  readonly captureId: string;
  readonly database: BoozeDatabase;
  readonly runId?: string;
  readonly workflowInstanceId: string;
}): Promise<{ readonly runId: string; readonly attemptNumber: number } | null> {
  await database.run(sql`INSERT INTO ${bottleCaptureRuns}
    (id, capture_id, status, extractor_version, prompt_version, schema_version, attempt_number, started_at)
    SELECT ${runId}, id, 'extracting', 'bottle-ocr-v2', 'capture-review-v2', 'wine-vintage-v2',
      (SELECT coalesce(max(attempt_number), 0) + 1 FROM bottle_capture_runs WHERE capture_id = ${captureId}),
      CURRENT_TIMESTAMP
    FROM ${bottleCaptures}
    WHERE id = ${captureId} AND workflow_instance_id = ${workflowInstanceId}
      AND status = 'extracting'
    ON CONFLICT(id) DO NOTHING`);
  const [run] = await database
    .select({ runId: bottleCaptureRuns.id, attemptNumber: bottleCaptureRuns.attemptNumber })
    .from(bottleCaptureRuns)
    .innerJoin(bottleCaptures, eq(bottleCaptureRuns.captureId, bottleCaptures.id))
    .where(
      and(
        eq(bottleCaptureRuns.id, runId),
        eq(bottleCaptures.id, captureId),
        eq(bottleCaptures.workflowInstanceId, workflowInstanceId),
        eq(bottleCaptures.status, "extracting"),
        eq(latestCaptureRunId(captureId), runId),
      ),
    )
    .limit(1);
  return run ?? null;
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
}): Promise<boolean> {
  const updated = await database
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
    )
    .returning({ id: bottleCaptures.id });
  return updated.length === 1;
}

export async function saveCaptureReview({
  captureId,
  database,
  candidate,
  expectedRevision,
  siteId,
  userId,
}: {
  readonly captureId: string;
  readonly database: BoozeDatabase;
  readonly candidate: CaptureReviewCandidate;
  readonly expectedRevision: number;
  readonly siteId: string;
  readonly userId: string;
}): Promise<number> {
  const [, [saved]] = await commitOperation({ database, userId, source: "http" }, siteId, [
    database
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
          eq(bottleCaptures.siteId, siteId),
          eq(bottleCaptures.reviewRevision, expectedRevision),
          sql`${bottleCaptures.status} IN ('failed', 'needs_review')`,
        ),
      )
      .returning({ revision: bottleCaptures.reviewRevision }),
  ]);
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
  siteId,
  userId,
}: {
  readonly captureId: string;
  readonly database: BoozeDatabase;
  readonly expectedReviewRevision: number;
  readonly siteId: string;
  readonly userId: string;
}): Promise<string> {
  const runId = `manual_${captureId}`;
  await commitOperation({ database, userId, source: "http" }, siteId, [
    database
      .insert(bottleCaptureRuns)
      .select(
        database
          .select({
            id: sql<string>`${runId}`.as("id"),
            captureId: bottleCaptures.id,
            status: sql<string>`'needs_review'`.as("status"),
            extractorVersion: sql<string>`'manual-review'`.as("extractor_version"),
            promptVersion: sql<string>`'manual-review'`.as("prompt_version"),
            schemaVersion: sql<string>`'wine-vintage-v2'`.as("schema_version"),
            attemptNumber: sql<number>`1`.as("attempt_number"),
          })
          .from(bottleCaptures)
          .where(
            and(
              eq(bottleCaptures.id, captureId),
              eq(bottleCaptures.siteId, siteId),
              eq(bottleCaptures.status, "needs_review"),
              eq(bottleCaptures.reviewRevision, expectedReviewRevision),
              sql`${bottleCaptures.reviewCandidateJson} IS NOT NULL`,
              sql`${latestCaptureRunId(captureId)} IS NULL`,
            ),
          ),
      )
      .onConflictDoNothing({ target: bottleCaptureRuns.id }),
  ]);
  return runId;
}

export async function reserveCaptureRetry({
  captureId,
  database,
  workflowInstanceId,
  expectedWorkflowInstanceId,
  expectedReviewRevision,
  siteId,
  userId,
}: {
  readonly captureId: string;
  readonly database: BoozeDatabase;
  readonly workflowInstanceId: string;
  readonly expectedWorkflowInstanceId: string | null;
  readonly expectedReviewRevision: number;
  readonly siteId: string;
  readonly userId: string;
}): Promise<boolean> {
  const [, reserved] = await commitOperation({ database, userId, source: "http" }, siteId, [
    database
      .update(bottleCaptures)
      .set({
        status: "queued",
        workflowInstanceId,
        errorMessage: null,
        errorDetailJson: null,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(
        and(
          eq(bottleCaptures.id, captureId),
          eq(bottleCaptures.siteId, siteId),
          sql`${bottleCaptures.status} IN ('failed', 'needs_review')`,
          sql`${bottleCaptures.workflowInstanceId} IS ${expectedWorkflowInstanceId}`,
          eq(bottleCaptures.reviewRevision, expectedReviewRevision),
        ),
      )
      .returning({ id: bottleCaptures.id }),
  ]);
  return reserved.length === 1;
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
      AND status IN ('queued', 'extracting')`);
  return result.meta.changes === 1;
}

export type CaptureImportClaim = {
  readonly captureId: string;
  readonly runId: string;
  readonly siteId: string;
  readonly workflowInstanceId: string | null;
};

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
  captureOwner,
}: {
  readonly captureOwner?: {
    readonly captureId: string;
    readonly workflowInstanceId: string;
    readonly expectedCaptureStatus: "extracting";
  };
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
}): Promise<boolean> {
  const updated = await database
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
        captureOwner === undefined
          ? undefined
          : and(
              eq(bottleCaptureRuns.captureId, captureOwner.captureId),
              eq(latestCaptureRunId(captureOwner.captureId), runId),
              sql`EXISTS (SELECT 1 FROM ${bottleCaptures} WHERE ${bottleCaptures.id} = ${captureOwner.captureId}
            AND ${bottleCaptures.workflowInstanceId} = ${captureOwner.workflowInstanceId}
            AND ${bottleCaptures.status} = ${captureOwner.expectedCaptureStatus})`,
            ),
        status === "imported" ? undefined : ne(bottleCaptureRuns.status, "imported"),
      ),
    )
    .returning({ id: bottleCaptureRuns.id });
  return updated.length === 1;
}

async function listCaptureImages({
  captureId,
  database,
  userId,
}: {
  readonly captureId: string;
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
    .where(and(eq(siteMemberships.userId, userId), eq(bottleCaptures.id, captureId)))
    .orderBy(bottleCaptureImages.sortOrder);

  const imagesByCapture = new Map<string, CaptureImageResource[]>();
  for (const { captureId: rowCaptureId, ...image } of rows) {
    const images = imagesByCapture.get(rowCaptureId) ?? [];
    images.push({
      ...image,
      imageUrl: captureImageUrl(rowCaptureId, image.imageAssetId),
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
  readonly captureId: string;
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
        eq(bottleCaptures.id, captureId),
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

function captureImageUrl(captureId: string, imageAssetId: string): string {
  return `/api/bottle-captures/${encodeURIComponent(captureId)}/images/${encodeURIComponent(imageAssetId)}`;
}

function parseStoredCaptureReviewCandidate(value: string | null) {
  if (value === null) return null;
  const result = captureReviewCandidateResourceSchema.safeParse(parseJson(value));
  if (!result.success) throw new Error("Stored capture review is invalid");
  return result.data;
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
