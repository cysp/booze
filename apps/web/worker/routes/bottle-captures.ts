import { createBottleCapture } from "../capture-intake.ts";
// oxlint-disable import/max-dependencies -- Capture route composes storage, workflow, OCR, import, and authorization boundaries.
import { createD1Client } from "@chikachow/booze-db";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { captureReviewCandidateSchema, isIdentifiedCapture } from "../../shared/capture-review.ts";
import { candidateValidationIssueSchema } from "../../shared/catalogue-inputs.ts";
import { additionOperationIdSchema } from "../../shared/addition-operation.ts";
import { validateBottleQuantity } from "../../shared/quantity.ts";
import { z } from "zod";

import { requireAuthenticatedUser, requireSitePermission } from "../api/auth.ts";
import { created, noContent } from "../api/http.ts";
import { optionalText } from "../api/ids.ts";
import { readRequestJson } from "../api/request-body.ts";
import type { Bindings } from "../api/types.ts";
import { getCommittedCaptureImport, importReviewedCapture } from "../bottle-importer.ts";
import type { ImportCandidate } from "../bottle-extractor.ts";
import { canImportCapture, canRetryCapture } from "../capture-state.ts";
import {
  ensureManualCaptureRun,
  saveCaptureReview,
  getBottleCapture,
  getCaptureImageObject,
  listBottleCaptures,
  reserveCaptureRetry,
  updateCaptureStatus,
} from "../capture-store.ts";
import { deleteBottleCaptureData, tryDrainR2ObjectDeletionQueue } from "../deletion.ts";
import { errorDetails, logError } from "../observability.ts";

const manualImportSchema = z.object({
  wineVintageId: z.string().trim().min(1).optional(),
  expectedReviewRevision: z.number().int().nonnegative().default(0),
  allowUnidentified: z.boolean().default(false),
});

export const bottleCaptureRoutes = new Hono<{ Bindings: Bindings }>()
  .get("/bottle-captures", async (context) => {
    const database = createD1Client(context.env.DB);
    const authenticatedUser = await requireAuthenticatedUser({
      database,
      request: context.req.raw,
      headers: context.req.raw.headers,
      secretKey: context.env.CLERK_SECRET_KEY,
    });
    return context.json({
      data: await listBottleCaptures({ database, userId: authenticatedUser.userId }),
    });
  })
  .post("/bottle-captures", async (context) => {
    const contentType = context.req.header("content-type") ?? "";
    if (!contentType.toLowerCase().includes("multipart/form-data")) {
      throw new HTTPException(415, { message: "Use multipart/form-data for capture images" });
    }

    const database = createD1Client(context.env.DB);
    const authenticatedUser = await requireAuthenticatedUser({
      database,
      request: context.req.raw,
      headers: context.req.raw.headers,
      secretKey: context.env.CLERK_SECRET_KEY,
    });
    const formData = await readCaptureFormData(context.req.raw);
    const siteId = z.string().trim().min(1).parse(stringField(formData, "siteId"));
    const operationId = additionOperationIdSchema.parse(stringField(formData, "operationId"));
    await requireSitePermission({
      database,
      permission: "site.content.write",
      siteId,
      userId: authenticatedUser.userId,
    });
    const storageLocationId = optionalText(stringField(formData, "storageLocationId"));
    const files = formData.getAll("images").filter((entry) => entry instanceof File);

    const capture = await createBottleCapture({
      operationId,
      bucket: context.env.IMAGE_BUCKET,
      database,
      files,
      positionHint: optionalText(stringField(formData, "positionHint")),
      quantity: parseCaptureQuantity(stringField(formData, "quantity")),
      siteId,
      storageLocationId,
      userId: authenticatedUser.userId,
    });
    if (capture.status === "replayed") {
      return created(
        await captureSubmissionResult({
          captureId: capture.captureId,
          database,
          userId: authenticatedUser.userId,
        }),
      );
    }
    if (capture.status === "upload_failed") {
      return created({
        captureId: capture.captureId,
        errorMessage: capture.errorMessage,
        workflowInstanceId: null,
        intakeComplete: false,
      });
    }
    try {
      const instance = await context.env.BOTTLE_CAPTURE_WORKFLOW.create({
        id: capture.captureId,
        params: { captureId: capture.captureId },
      });
      return created({
        captureId: capture.captureId,
        workflowInstanceId: instance.id,
        intakeComplete: true,
      });
    } catch (error) {
      const details = errorDetails(error);
      const errorMessage =
        "Capture was saved, but extraction startup could not be confirmed. Refresh capture status before retrying.";
      logError("bottle_capture_workflow_start_failed", {
        captureId: capture.captureId,
        error: details,
        fileCount: files.length,
        siteId,
        storageLocationId,
      });
      await updateCaptureStatus({
        captureId: capture.captureId,
        database,
        status: "failed",
        workflowInstanceId: capture.captureId,
        expectedStatus: "queued",
        errorMessage,
        errorDetail: details,
      });
      return created({
        captureId: capture.captureId,
        errorMessage,
        workflowInstanceId: null,
        intakeComplete: true,
      });
    }
  })
  .get("/bottle-captures/:captureId", async (context) => {
    const database = createD1Client(context.env.DB);
    const authenticatedUser = await requireAuthenticatedUser({
      database,
      request: context.req.raw,
      headers: context.req.raw.headers,
      secretKey: context.env.CLERK_SECRET_KEY,
    });
    return context.json({
      data: await getBottleCapture({
        captureId: context.req.param("captureId"),
        database,
        userId: authenticatedUser.userId,
      }),
    });
  })
  .get("/bottle-captures/:captureId/images/:imageAssetId", async (context) => {
    const database = createD1Client(context.env.DB);
    const authenticatedUser = await requireAuthenticatedUser({
      database,
      request: context.req.raw,
      headers: context.req.raw.headers,
      secretKey: context.env.CLERK_SECRET_KEY,
    });
    const image = await getCaptureImageObject({
      captureId: context.req.param("captureId"),
      database,
      imageAssetId: context.req.param("imageAssetId"),
      original: context.req.query("original") === "1",
      userId: authenticatedUser.userId,
    });
    const object = await context.env.IMAGE_BUCKET.get(image.r2Key);
    if (object === null) {
      throw new HTTPException(404, { message: "Capture image object not found" });
    }
    const response = new Response(object.body, { headers: { "content-type": image.contentType } });
    if (image.needsThumbnail && context.env.IMAGES !== undefined && response.body !== null) {
      const bytes = response.body.pipeThrough(
        new TransformStream<unknown, Uint8Array>({
          transform(chunk, controller) {
            if (!(chunk instanceof Uint8Array))
              throw new TypeError("Image object body must contain bytes");
            controller.enqueue(chunk);
          },
        }),
      );
      const thumbnail = await context.env.IMAGES.input(bytes)
        .transform({ fit: "cover", height: 240, width: 240 })
        .output({ format: "image/webp", quality: 75 });
      return new Response(thumbnail.image(), {
        headers: { "content-type": thumbnail.contentType() },
      });
    }
    return response;
  })
  .post("/bottle-captures/:captureId/retry", async (context) => {
    const database = createD1Client(context.env.DB);
    const authenticatedUser = await requireAuthenticatedUser({
      database,
      request: context.req.raw,
      headers: context.req.raw.headers,
      secretKey: context.env.CLERK_SECRET_KEY,
    });
    const capture = await getBottleCapture({
      captureId: context.req.param("captureId"),
      database,
      userId: authenticatedUser.userId,
    });
    await requireSitePermission({
      database,
      permission: "site.content.write",
      siteId: capture.siteId,
      userId: authenticatedUser.userId,
    });
    if (!canRetryCapture(capture.status)) {
      throw new HTTPException(409, { message: "Capture is not retryable" });
    }
    const workflowInstanceId = `${capture.id}-${crypto.randomUUID()}`;
    if (!(await reserveCaptureRetry({ captureId: capture.id, database, workflowInstanceId }))) {
      throw new HTTPException(409, { message: "Capture processing is already in progress" });
    }
    try {
      await context.env.BOTTLE_CAPTURE_WORKFLOW.create({
        id: workflowInstanceId,
        params: { captureId: capture.id },
      });
    } catch (error) {
      await updateCaptureStatus({
        captureId: capture.id,
        database,
        workflowInstanceId,
        status: "failed",
        expectedStatus: "queued",
        errorMessage: "Capture was saved, but extraction did not start. Retry the capture.",
        errorDetail: errorDetails(error),
      });
      throw new HTTPException(503, {
        message: "Could not confirm extraction started. Refresh capture status before retrying.",
      });
    }
    return context.json({ data: { captureId: capture.id, workflowInstanceId } });
  })
  .patch("/bottle-captures/:captureId/review", async (context) => {
    const payload = z
      .object({
        expectedRevision: z.number().int().nonnegative(),
        candidate: captureReviewCandidateSchema,
      })
      .parse(await readRequestJson(context.req.raw));
    const database = createD1Client(context.env.DB);
    const user = await requireAuthenticatedUser({
      database,
      request: context.req.raw,
      headers: context.req.raw.headers,
      secretKey: context.env.CLERK_SECRET_KEY,
    });
    const capture = await getBottleCapture({
      captureId: context.req.param("captureId"),
      database,
      userId: user.userId,
    });
    await requireSitePermission({
      database,
      permission: "site.content.write",
      siteId: capture.siteId,
      userId: user.userId,
    });
    const reviewRevision = await saveCaptureReview({
      captureId: capture.id,
      database,
      candidate: payload.candidate,
      expectedRevision: payload.expectedRevision,
    });
    return context.json({ data: { reviewRevision, reviewCandidate: payload.candidate } });
  })
  .post("/bottle-captures/:captureId/import", async (context) => {
    const payload = manualImportSchema.parse(await readRequestJson(context.req.raw));
    const database = createD1Client(context.env.DB);
    const authenticatedUser = await requireAuthenticatedUser({
      database,
      request: context.req.raw,
      headers: context.req.raw.headers,
      secretKey: context.env.CLERK_SECRET_KEY,
    });
    const capture = await getBottleCapture({
      captureId: context.req.param("captureId"),
      database,
      userId: authenticatedUser.userId,
    });
    await requireSitePermission({
      database,
      permission: "site.content.write",
      siteId: capture.siteId,
      userId: authenticatedUser.userId,
    });
    if (capture.status === "imported" && capture.latestRun !== null) {
      const committed = await getCommittedCaptureImport({
        captureId: capture.id,
        database,
        runId: capture.latestRun.id,
      });
      if (committed !== null) return context.json({ data: committed });
    }
    if (!canImportCapture(capture.status)) {
      throw new HTTPException(409, { message: "Capture is not ready for manual import" });
    }
    if (capture.reviewRevision !== payload.expectedReviewRevision) {
      throw new HTTPException(409, {
        message: "Saved corrections changed. Refresh the capture before importing.",
      });
    }
    const source = capture.reviewCandidate ?? capture.latestRun?.importCandidate;
    const extractionIssues = z
      .object({ validationIssues: z.array(candidateValidationIssueSchema).optional() })
      .safeParse(capture.latestRun?.importCandidate);
    const unresolved = (
      extractionIssues.success ? (extractionIssues.data.validationIssues ?? []) : []
    ).filter((issue) => {
      if (payload.wineVintageId !== undefined && issue.path.startsWith("wine.")) return false;
      return (
        capture.reviewCandidate === null ||
        (issue.path === "bottle.volumeMl" && capture.reviewCandidate.bottle.volumeMl === undefined)
      );
    });
    if (unresolved.length > 0) {
      throw new HTTPException(400, {
        message: `${unresolved.map((issue) => `${issue.path}: ${issue.message} Label value: ${JSON.stringify(issue.rawValue)}.`).join(" ")} Save corrected details before importing this capture.`,
      });
    }
    // Reusing a selected wine does not apply OCR wine metadata. Validate only
    // the physical bottle facts, so conflicting OCR wine facts cannot block it.
    const reviewed =
      payload.wineVintageId === undefined
        ? captureReviewCandidateSchema.parse(source)
        : captureReviewCandidateSchema.parse({
            wine: {},
            bottle: z.object({ bottle: captureReviewCandidateSchema.shape.bottle }).parse(source)
              .bottle,
          });
    const candidate: ImportCandidate = { ...reviewed, rawSuggestion: {} };
    if (
      payload.wineVintageId === undefined &&
      !isIdentifiedCapture(reviewed) &&
      !payload.allowUnidentified
    ) {
      throw new HTTPException(400, {
        message:
          "Confirm saving as an unidentified wine, or enter a producer and a designation, grape variety, or appellation.",
      });
    }
    const runId =
      capture.latestRun?.id ??
      (await ensureManualCaptureRun({
        captureId: capture.id,
        database,
        expectedReviewRevision: payload.expectedReviewRevision,
      }));
    const imported = await importReviewedCapture({
      candidate,
      captureId: capture.id,
      database,
      runId,
      workflowInstanceId: capture.workflowInstanceId,
      quantity: capture.quantity,
      siteId: capture.siteId,
      wineVintageId: payload.wineVintageId,
      expectedReviewRevision: payload.expectedReviewRevision,
    });
    return context.json({ data: imported });
  })
  .delete("/bottle-captures/:captureId", async (context) => {
    const database = createD1Client(context.env.DB);
    const authenticatedUser = await requireAuthenticatedUser({
      database,
      request: context.req.raw,
      headers: context.req.raw.headers,
      secretKey: context.env.CLERK_SECRET_KEY,
    });
    const capture = await getBottleCapture({
      captureId: context.req.param("captureId"),
      database,
      userId: authenticatedUser.userId,
    });
    await requireSitePermission({
      database,
      permission: "site.content.write",
      siteId: capture.siteId,
      userId: authenticatedUser.userId,
    });
    if (["queued", "extracting", "importing"].includes(capture.status)) {
      throw new HTTPException(409, {
        message: "Wait for capture processing to finish before deleting it",
      });
    }

    const deleted = await deleteBottleCaptureData({
      captureId: capture.id,
      database: context.env.DB,
    });
    if (!deleted) {
      throw new HTTPException(409, {
        message: "Capture processing started before deletion. Wait for it to finish.",
      });
    }
    await tryDrainR2ObjectDeletionQueue({
      bucket: context.env.IMAGE_BUCKET,
      database: context.env.DB,
    });
    return noContent();
  });

function stringField(formData: FormData, name: string): string | undefined {
  const value = formData.get(name);
  return typeof value === "string" ? value : undefined;
}

export function parseCaptureQuantity(value: string | undefined): number {
  const result = validateBottleQuantity(value);
  if (!result.ok) {
    throw new HTTPException(400, { message: result.message });
  }
  return result.value;
}

export async function readCaptureFormData(request: Request): Promise<FormData> {
  // Four 8 MiB originals plus bounded room for multipart headers and form fields.
  const maxRequestBytes = 33 * 1024 * 1024;
  if (Number(request.headers.get("content-length")) > maxRequestBytes) {
    throw new HTTPException(413, { message: "Capture upload exceeds 33MB" });
  }
  let size = 0;
  const body = request.body?.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.byteLength;
        if (size > maxRequestBytes) {
          throw new HTTPException(413, { message: "Capture upload exceeds 33MB" });
        }
        controller.enqueue(chunk);
      },
    }),
  );
  try {
    return await new Response(body, { headers: request.headers }).formData();
  } catch (error) {
    if (size > maxRequestBytes) {
      throw new HTTPException(413, { message: "Capture upload exceeds 33MB" });
    }
    if (error instanceof HTTPException) throw error;
    throw new HTTPException(400, { message: "Invalid capture upload form" });
  }
}

async function captureSubmissionResult({
  captureId,
  database,
  userId,
}: {
  readonly captureId: string;
  readonly database: ReturnType<typeof createD1Client>;
  readonly userId: string;
}) {
  const capture = await getBottleCapture({ captureId, database, userId });
  const intakeComplete = capture.status !== "uploading" && capture.status !== "upload_failed";
  if (!intakeComplete) {
    return {
      captureId,
      workflowInstanceId: null,
      intakeComplete,
      errorMessage:
        capture.errorMessage ??
        "Capture images are not all saved yet. Submit the same photos again to resume, or delete this capture.",
    };
  }
  if (capture.errorMessage !== null) {
    return {
      captureId,
      workflowInstanceId: null,
      intakeComplete,
      errorMessage: capture.errorMessage,
    };
  }
  return { captureId, workflowInstanceId: capture.workflowInstanceId, intakeComplete };
}
