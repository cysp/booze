import { createD1Client } from "@chikachow/booze-db";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

import type { Bindings, BottleCaptureWorkflowParams } from "./api/types.ts";
import {
  buildCaptureImportCandidate,
  extractCaptureLabelEvidence,
  type CaptureExtractorResult,
  type ImportCandidate,
} from "./bottle-extractor.ts";
import {
  BottleOcrError,
  defaultBottleExtractorId,
  type BottleOcrDiagnostic,
} from "./bottle-ocr.ts";
import { putCaptureRunArtifact, type CaptureRunArtifact } from "./capture-artifacts.ts";
import {
  createCaptureRun,
  beginCaptureWorkflow,
  getCaptureForWorkflow,
  updateCaptureRun,
  updateCaptureStatus,
  type CaptureWorkflowRecord,
} from "./capture-store.ts";
import { errorDetails, logError, logInfo } from "./observability.ts";

type CaptureRunContext = {
  readonly capture: CaptureWorkflowRecord;
  readonly runId: string;
};
type CaptureDraft = ReturnType<typeof buildCaptureImportCandidate>;

export class BottleCaptureWorkflow extends WorkflowEntrypoint<
  Bindings,
  BottleCaptureWorkflowParams
> {
  public override async run(
    event: Readonly<WorkflowEvent<BottleCaptureWorkflowParams>>,
    step: WorkflowStep,
  ): Promise<unknown> {
    const captureId = event.payload.captureId;
    const workflowInstanceId = event.instanceId;
    let failedStage = "start capture workflow";
    let runContext: CaptureRunContext | null = null;
    try {
      const started = await step.do("mark capture extracting", async () =>
        beginCaptureWorkflow({
          captureId,
          database: createD1Client(this.env.DB),
          workflowInstanceId,
        }),
      );
      if (!started) return { captureId, status: "skipped" };

      failedStage = "create capture run";
      runContext = await step.do("create capture run", async () => {
        const database = createD1Client(this.env.DB);
        const run = await createCaptureRun({
          captureId,
          database,
          runId: `run_${workflowInstanceId}`,
          workflowInstanceId,
        });
        if (run === null) return null;
        return { capture: await getCaptureForWorkflow({ captureId, database }), runId: run.runId };
      });
      if (runContext === null) return { captureId, status: "skipped" };
      const context = runContext;

      failedStage = "extract label evidence";
      const extraction = await runExtractorStep({
        captureId,
        context,
        env: this.env,
        step,
        workflowInstanceId,
      });
      if (extraction === null) return { captureId, status: "skipped" };
      const draft = buildCaptureImportCandidate({ extraction });

      failedStage = "write extraction artifact";
      const artifact = await writeExtractionArtifact({
        captureId,
        context,
        env: this.env,
        draft,
        extraction,
        step,
        workflowInstanceId,
      });
      if (artifact === null) return { captureId, status: "skipped" };

      failedStage = "record capture result";
      const recorded = await recordCaptureResult({
        captureId,
        context,
        env: this.env,
        draft,
        artifact,
        step,
        workflowInstanceId,
      });
      return { captureId, status: recorded ? "needs_review" : "skipped" };
    } catch (error) {
      const database = createD1Client(this.env.DB);
      const message = shortErrorMessage(error, failedStage);
      const artifact =
        runContext === null
          ? null
          : await tryPutErrorArtifact({
              bucket: this.env.IMAGE_BUCKET,
              captureId,
              error,
              failedStage,
              runId: runContext.runId,
              siteId: runContext.capture.siteId,
            });
      if (runContext !== null) {
        await updateCaptureRun({
          database,
          runId: runContext.runId,
          status: "failed",
          errorMessage: message,
          captureOwner: { captureId, workflowInstanceId, expectedCaptureStatus: "extracting" },
          ...(artifact === null ? {} : { errorDetailArtifact: artifact }),
        });
      }
      await updateCaptureStatus({
        captureId,
        database,
        status: "failed",
        workflowInstanceId,
        expectedStatus: "extracting",
        ...(runContext === null ? {} : { runId: runContext.runId }),
        errorMessage: message,
        errorDetail: runContext === null ? errorDetails(error) : null,
      });
      return { captureId, failedStage, status: "failed" };
    }
  }
}

async function activeRun({
  captureId,
  context,
  env,
  workflowInstanceId,
}: {
  readonly captureId: string;
  readonly context: CaptureRunContext;
  readonly env: Bindings;
  readonly workflowInstanceId: string;
}): Promise<boolean> {
  // Recheck current state inside every fresh side-effect step. Old deployments
  // may have cached start/run contexts without Workflow ownership fields.
  return updateCaptureStatus({
    captureId,
    database: createD1Client(env.DB),
    runId: context.runId,
    workflowInstanceId,
    status: "extracting",
    expectedStatus: "extracting",
  });
}

async function runExtractorStep(args: {
  readonly captureId: string;
  readonly context: CaptureRunContext;
  readonly env: Bindings;
  readonly step: WorkflowStep;
  readonly workflowInstanceId: string;
}): Promise<CaptureExtractorResult | null> {
  const { captureId, context, env, step } = args;
  return step.do(
    `extract label evidence with ${defaultBottleExtractorId}`,
    {
      retries: { limit: 1, delay: "5 minutes", backoff: "constant" },
      timeout: "8 minutes",
    },
    async () => {
      if (!(await activeRun(args))) return null;
      const diagnostics: BottleOcrDiagnostic[] = [];
      try {
        const extraction = await extractCaptureLabelEvidence({
          bucket: env.IMAGE_BUCKET,
          images: env.IMAGES,
          capture: context.capture,
          diagnostics,
          gatewayToken: env.CF_AIG_TOKEN,
          gatewayUrl: env.AI_GATEWAY_URL,
        });
        logInfo("bottle_capture_extractor_completed", {
          captureId,
          diagnosticCount: diagnostics.length,
          extractorId: extraction.extractorId,
          model: extraction.model,
          runId: context.runId,
          siteId: context.capture.siteId,
        });
        return { ...extraction, diagnostics };
      } catch (error) {
        logError("bottle_capture_extractor_failed", {
          captureId,
          diagnostics,
          error: errorDetails(error),
          extractorId: defaultBottleExtractorId,
          runId: context.runId,
          siteId: context.capture.siteId,
        });
        throw error;
      }
    },
  );
}

async function writeExtractionArtifact(args: {
  readonly captureId: string;
  readonly context: CaptureRunContext;
  readonly env: Bindings;
  readonly draft: CaptureDraft;
  readonly extraction: CaptureExtractorResult;
  readonly step: WorkflowStep;
  readonly workflowInstanceId: string;
}): Promise<CaptureRunArtifact | null> {
  const { captureId, context, env, draft, extraction, step, workflowInstanceId } = args;
  return step.do("write extraction artifact", async () => {
    if (!(await activeRun(args))) return null;
    const artifact = await putCaptureRunArtifact({
      bucket: env.IMAGE_BUCKET,
      captureId,
      kind: "extraction",
      runId: context.runId,
      siteId: context.capture.siteId,
      value: {
        schemaVersion: "capture-extraction-v2",
        captureId,
        runId: context.runId,
        workflowInstanceId,
        images: context.capture.images,
        quantity: context.capture.quantity,
        extractor: {
          ...extraction,
          // Cached extraction steps predate raw provider-response retention.
          // Record that gap rather than inventing a response or configuration.
          configuration: extraction.configuration ?? null,
          rawResponse: extraction.rawResponse ?? null,
          provenance:
            extraction.configuration === undefined
              ? "legacy_workflow_checkpoint"
              : "capture-extraction-v2",
        },
        importCandidate: draft.candidate,
        reviewReasons: draft.reviewReasons,
      },
    });
    await updateCaptureRun({
      database: createD1Client(env.DB),
      runId: context.runId,
      status: "extracting",
      captureOwner: { captureId, workflowInstanceId, expectedCaptureStatus: "extracting" },
      extractionArtifact: artifact,
      importCandidate: compactImportCandidate(draft.candidate),
      model: extraction.model,
    });
    return artifact;
  });
}

async function recordCaptureResult({
  captureId,
  context,
  env,
  draft,
  artifact,
  step,
  workflowInstanceId,
}: {
  readonly captureId: string;
  readonly context: CaptureRunContext;
  readonly env: Bindings;
  readonly draft: CaptureDraft;
  readonly artifact: CaptureRunArtifact;
  readonly step: WorkflowStep;
  readonly workflowInstanceId: string;
}): Promise<boolean> {
  return step.do("record reviewed capture draft", async () => {
    const database = createD1Client(env.DB);
    const result = {
      kind: "needs_review",
      reason: "human_confirmation_required",
      reviewReasons: draft.reviewReasons,
      matchResult: null,
    };
    await updateCaptureRun({
      database,
      runId: context.runId,
      status: "needs_review",
      captureOwner: { captureId, workflowInstanceId, expectedCaptureStatus: "extracting" },
      extractionArtifact: artifact,
      importCandidate: compactImportCandidate(draft.candidate),
      importResult: result,
      matchResult: null,
    });
    return updateCaptureStatus({
      captureId,
      database,
      status: "needs_review",
      workflowInstanceId,
      runId: context.runId,
      expectedStatus: "extracting",
    });
  });
}

function compactImportCandidate(candidate: ImportCandidate): ImportCandidate {
  return { ...candidate, rawSuggestion: {} };
}

function shortErrorMessage(error: unknown, stage: string): string {
  const message = error instanceof Error ? error.message : String(error);
  const firstLine = message.split("\n", 1)[0]?.trim() ?? "";
  const detail = firstLine === "" ? "Capture extraction failed" : firstLine;
  const preview = `${stage}: ${detail}`;
  return preview.length <= 300 ? preview : `${preview.slice(0, 297)}...`;
}

async function tryPutErrorArtifact({
  bucket,
  captureId,
  error,
  failedStage,
  runId,
  siteId,
}: {
  readonly bucket: R2Bucket;
  readonly captureId: string;
  readonly error: unknown;
  readonly failedStage: string;
  readonly runId: string;
  readonly siteId: string;
}): Promise<CaptureRunArtifact | null> {
  try {
    return await putCaptureRunArtifact({
      bucket,
      captureId,
      kind: "error",
      runId,
      siteId,
      value: {
        captureId,
        error: errorDetails(error),
        failedStage,
        runId,
        ...(error instanceof BottleOcrError ? { rawResponse: error.rawResponse } : {}),
      },
    });
  } catch (artifactError) {
    logError("capture_error_artifact_write_failed", {
      captureId,
      error: errorDetails(artifactError),
      runId,
      siteId,
    });
    return null;
  }
}
