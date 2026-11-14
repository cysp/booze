import {
  bottleCaptureImages,
  bottleCaptures,
  captureImageUploads,
  imageAssets,
  r2ObjectDeletionQueue,
  storageLocations,
  type BoozeDatabase,
} from "@chikachow/booze-db";
import { and, eq, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
  additionFingerprint,
  additionOperationIdSchema,
  contentDigest,
} from "../shared/addition-operation.ts";
import { additionReceiptStatement, getAdditionReceipt } from "./addition-receipts.ts";
import { errorDetails, logError } from "./observability.ts";

const supportedImageTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);
const uploadFailureMessage =
  "Capture image upload did not complete. Submit the same photos again to resume, or delete this capture.";
type UploadManifest = typeof captureImageUploads.$inferSelect;
type CaptureIntakeInput = {
  readonly bucket: R2Bucket;
  readonly operationId: string;
  readonly database: BoozeDatabase;
  readonly files: readonly File[];
  readonly positionHint: string | null;
  readonly quantity: number;
  readonly siteId: string;
  readonly storageLocationId: string | null;
  readonly userId: string;
};
export type CreateBottleCaptureResult =
  | { readonly captureId: string; readonly status: "replayed" | "queued" }
  | { readonly captureId: string; readonly errorMessage: string; readonly status: "upload_failed" };

export function validateCaptureFiles(files: readonly File[]): void {
  if (files.length === 0)
    throw new HTTPException(400, { message: "At least one image is required" });
  if (files.length > 4) throw new HTTPException(400, { message: "Choose up to 4 images" });
  for (const file of files) {
    if (!supportedImageTypes.has(file.type))
      throw new HTTPException(415, {
        message: "Only JPEG, PNG, WebP, HEIC, or HEIF images are supported",
      });
    if (file.size > 8 * 1024 * 1024)
      throw new HTTPException(413, { message: "Images must be smaller than 8MB" });
  }
}

export async function createBottleCapture(
  input: CaptureIntakeInput,
): Promise<CreateBottleCaptureResult> {
  const {
    bucket,
    database,
    files,
    operationId,
    positionHint,
    quantity,
    siteId,
    storageLocationId,
    userId,
  } = input;
  additionOperationIdSchema.parse(operationId);
  validateCaptureFiles(files);
  // Hash sequentially: keep only one bounded original buffer in addition to the
  // parsed multipart request, rather than allocating all four again together.
  const fileFacts = [];
  for (const file of files)
    fileFacts.push({
      name: file.name,
      contentType: file.type,
      size: file.size,
      digest: await contentDigest(await file.arrayBuffer()),
    });
  const operation = {
    userId,
    kind: "capture" as const,
    operationId,
    siteId,
    fingerprint: await additionFingerprint({
      siteId,
      storageLocationId,
      positionHint,
      quantity,
      images: fileFacts,
    }),
  };
  const resultSchema = z.object({ captureId: z.string() });
  const receipt = await getAdditionReceipt(database, operation, resultSchema);
  let captureId = receipt?.captureId;
  if (captureId === undefined) {
    if (storageLocationId !== null) {
      const [location] = await database
        .select({ id: storageLocations.id })
        .from(storageLocations)
        .where(and(eq(storageLocations.id, storageLocationId), eq(storageLocations.siteId, siteId)))
        .limit(1);
      if (location === undefined)
        throw new HTTPException(400, { message: "Storage location is not in the capture site" });
    }
    captureId = crypto.randomUUID();
    const id = captureId;
    try {
      await database.batch([
        additionReceiptStatement(database, operation, { captureId }),
        database.insert(bottleCaptures).values({
          id,
          workflowInstanceId: id,
          siteId,
          userId,
          storageLocationId,
          positionHint,
          quantity,
          status: "uploading",
          errorMessage: null,
        }),
        ...fileFacts.map((file, sortOrder) => {
          const writeId = crypto.randomUUID();
          return database.insert(captureImageUploads).values({
            captureId: id,
            sortOrder,
            writeId,
            r2Key: originalKey(siteId, id, writeId),
            sha256: file.digest,
            contentType: file.contentType,
            sizeBytes: file.size,
            originalFilename: file.name || null,
          });
        }),
      ]);
    } catch (error) {
      const stored = await getAdditionReceipt(database, operation, resultSchema);
      if (stored === undefined) throw error;
      captureId = stored.captureId;
    }
  }
  if (!(await isPendingIntake(database, captureId))) return { captureId, status: "replayed" };
  try {
    for (const [sortOrder, file] of files.entries())
      await saveOriginal({ bucket, database, captureId, sortOrder, file });
    // Only the request that transitions intake to queued launches extraction.
    const [finished] = await database
      .update(bottleCaptures)
      .set({
        status: "queued",
        errorMessage: null,
        errorDetailJson: null,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(
        and(
          eq(bottleCaptures.id, captureId),
          pendingIntake(),
          sql`(SELECT count(*) FROM ${bottleCaptureImages} WHERE ${bottleCaptureImages.captureId} = ${captureId}) = ${files.length}`,
        ),
      )
      .returning({ id: bottleCaptures.id });
    if (finished !== undefined) return { captureId, status: "queued" };
    if (await isPendingIntake(database, captureId))
      throw new Error("Capture originals are not all attached yet. Submit the same photos again.");
    return { captureId, status: "replayed" };
  } catch (error) {
    if (error instanceof HTTPException && error.status === 410) throw error;
    await database
      .update(bottleCaptures)
      .set({
        status: "upload_failed",
        errorMessage: uploadFailureMessage,
        errorDetailJson: JSON.stringify(errorDetails(error)),
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(and(eq(bottleCaptures.id, captureId), pendingIntake()));
    if (!(await isPendingIntake(database, captureId))) return { captureId, status: "replayed" };
    logError("bottle_capture_image_intake_failed", {
      captureId,
      error: errorDetails(error),
      fileCount: files.length,
      siteId,
    });
    return { captureId, status: "upload_failed", errorMessage: uploadFailureMessage };
  }
}

function pendingIntake() {
  return sql`${bottleCaptures.status} IN ('uploading', 'upload_failed')`;
}
async function isPendingIntake(database: BoozeDatabase, captureId: string): Promise<boolean> {
  const [capture] = await database
    .select({ status: bottleCaptures.status })
    .from(bottleCaptures)
    .where(eq(bottleCaptures.id, captureId))
    .limit(1);
  if (capture === undefined)
    throw new HTTPException(410, {
      message: "This capture was deleted. Start a new capture to add these photos again.",
    });
  return capture.status === "uploading" || capture.status === "upload_failed";
}
async function loadManifest(
  database: BoozeDatabase,
  captureId: string,
  sortOrder: number,
): Promise<UploadManifest | undefined> {
  const [manifest] = await database
    .select()
    .from(captureImageUploads)
    .where(
      and(
        eq(captureImageUploads.captureId, captureId),
        eq(captureImageUploads.sortOrder, sortOrder),
        liveManifest(),
      ),
    )
    .limit(1);
  return manifest;
}
function liveManifest() {
  return sql`EXISTS (SELECT 1 FROM ${bottleCaptures} WHERE ${bottleCaptures.id} = ${captureImageUploads.captureId} AND ${pendingIntake()})`;
}
async function registeredUpload(
  bucket: R2Bucket,
  database: BoozeDatabase,
  manifest: UploadManifest,
): Promise<{ readonly manifest: UploadManifest; readonly upload: R2MultipartUpload } | undefined> {
  if (manifest.uploadId !== null)
    return { manifest, upload: bucket.resumeMultipartUpload(manifest.r2Key, manifest.uploadId) };
  const upload = await bucket.createMultipartUpload(manifest.r2Key, {
    httpMetadata: { contentType: manifest.contentType },
    customMetadata: { captureWriteId: manifest.writeId },
  });
  let current: UploadManifest | undefined;
  try {
    [current] = await database
      .update(captureImageUploads)
      .set({ uploadId: upload.uploadId })
      .where(
        and(
          eq(captureImageUploads.writeId, manifest.writeId),
          sql`${captureImageUploads.uploadId} IS NULL`,
          liveManifest(),
        ),
      )
      .returning();
  } catch (error) {
    // Registration may have committed despite losing its acknowledgement.
    current = await loadManifest(database, manifest.captureId, manifest.sortOrder);
    if (current?.uploadId !== upload.uploadId) {
      await upload.abort();
      throw error;
    }
  }
  if (current?.uploadId === upload.uploadId) return { manifest: current, upload };
  // An unregistered upload never receives parts and can never complete. A
  // concurrent registrant, or deletion, may have won the D1 compare-and-set.
  await upload.abort();
  current = await loadManifest(database, manifest.captureId, manifest.sortOrder);
  if (current?.uploadId !== null && current?.uploadId !== undefined)
    return {
      manifest: current,
      upload: bucket.resumeMultipartUpload(current.r2Key, current.uploadId),
    };
  if (!(await isPendingIntake(database, manifest.captureId))) return undefined;
  throw new HTTPException(410, {
    message: "Capture intake was cancelled. Refresh before trying again.",
  });
}

async function saveOriginal({
  bucket,
  database,
  captureId,
  sortOrder,
  file,
}: {
  readonly bucket: R2Bucket;
  readonly database: BoozeDatabase;
  readonly captureId: string;
  readonly sortOrder: number;
  readonly file: File;
}): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const [linked] = await database
      .select({ id: bottleCaptureImages.imageAssetId })
      .from(bottleCaptureImages)
      .where(
        and(
          eq(bottleCaptureImages.captureId, captureId),
          eq(bottleCaptureImages.sortOrder, sortOrder),
        ),
      )
      .limit(1);
    if (linked !== undefined) return;
    const saved = await loadManifest(database, captureId, sortOrder);
    if (saved === undefined) {
      if (!(await isPendingIntake(database, captureId))) return;
      throw new Error("Capture upload reservation is missing");
    }
    const registered = await registeredUpload(bucket, database, saved);
    if (registered === undefined) return;
    const { manifest, upload } = registered;
    try {
      const part = await upload.uploadPart(1, await file.arrayBuffer());
      await upload.complete([part]);
    } catch (error) {
      if (!isMissingMultipartUpload(error)) throw error;
      // NoSuchUpload proves this ID is terminal. A negative HEAD before that
      // signal would not rule out an original completion still in flight.
      const object = await bucket.head(manifest.r2Key);
      if (
        object?.customMetadata?.["captureWriteId"] !== manifest.writeId ||
        object.size !== manifest.sizeBytes
      ) {
        await replaceTerminalUpload(database, manifest);
        continue;
      }
    }
    await linkOriginal(database, manifest);
    return;
  }
  throw new Error("The previous multipart upload expired. Submit the same photos again.");
}

function isMissingMultipartUpload(error: unknown): boolean {
  return (
    error instanceof Error &&
    /^(?:uploadPart|completeMultipartUpload): The specified multipart upload does not exist\. \(10024\)$/u.test(
      error.message,
    )
  );
}
async function replaceTerminalUpload(
  database: BoozeDatabase,
  manifest: UploadManifest,
): Promise<void> {
  const writeId = crypto.randomUUID();
  await database.batch([
    database
      .insert(r2ObjectDeletionQueue)
      .select(
        database
          .select({
            r2Key: captureImageUploads.r2Key,
            sourceKind: sql<string>`'capture_upload'`.as("source_kind"),
            sourceId: captureImageUploads.writeId,
            multipartUploadId: captureImageUploads.uploadId,
          })
          .from(captureImageUploads)
          .where(and(eq(captureImageUploads.writeId, manifest.writeId), liveManifest())),
      )
      .onConflictDoUpdate({
        target: r2ObjectDeletionQueue.r2Key,
        set: { multipartUploadId: manifest.uploadId },
      }),
    database
      .update(captureImageUploads)
      .set({ writeId, r2Key: originalKeyFromManifest(manifest, writeId), uploadId: null })
      .where(and(eq(captureImageUploads.writeId, manifest.writeId), liveManifest())),
  ]);
}
async function linkOriginal(database: BoozeDatabase, manifest: UploadManifest) {
  const current = and(eq(captureImageUploads.writeId, manifest.writeId), liveManifest());
  return database.batch([
    database
      .insert(imageAssets)
      .select(
        database
          .select({
            id: captureImageUploads.writeId,
            siteId: bottleCaptures.siteId,
            sha256: captureImageUploads.sha256,
            r2Key: captureImageUploads.r2Key,
            contentType: captureImageUploads.contentType,
            sizeBytes: captureImageUploads.sizeBytes,
            uploadedByUserId: bottleCaptures.userId,
          })
          .from(captureImageUploads)
          .innerJoin(bottleCaptures, eq(bottleCaptures.id, captureImageUploads.captureId))
          .where(current),
      )
      .onConflictDoNothing({ target: imageAssets.id }),
    database
      .insert(bottleCaptureImages)
      .select(
        database
          .select({
            captureId: captureImageUploads.captureId,
            imageAssetId: captureImageUploads.writeId,
            sortOrder: captureImageUploads.sortOrder,
            originalFilename: captureImageUploads.originalFilename,
          })
          .from(captureImageUploads)
          .where(current),
      )
      .onConflictDoNothing({
        target: [bottleCaptureImages.captureId, bottleCaptureImages.sortOrder],
      }),
  ]);
}
function originalKey(siteId: string, captureId: string, writeId: string): string {
  return `sites/${siteId}/captures/${captureId}/images/${writeId}`;
}
function originalKeyFromManifest(manifest: UploadManifest, writeId: string): string {
  return `${manifest.r2Key.slice(0, manifest.r2Key.lastIndexOf("/") + 1)}${writeId}`;
}
