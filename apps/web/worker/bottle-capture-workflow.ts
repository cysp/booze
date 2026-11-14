import { createD1Client } from "@chikachow/booze-db";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

import type { Bindings, BottleCaptureWorkflowParams } from "./api/types.ts";
import { importBottleCandidate, matchBottleCandidate } from "./bottle-importer.ts";
import {
  buildCaptureImportCandidate,
  defaultBottleExtractorConfigs,
  extractCaptureLabelEvidence,
  extractorsFromCaptureResults,
  reconcileCaptureLabelEvidence,
  type CaptureExtractorResult,
  type CaptureReconciliationResult,
  type CaptureImportReviewDecision,
  type ImportCandidate,
} from "./bottle-extractor.ts";
import { bottleExtractorId, type BottleOcrDiagnostic } from "./bottle-ocr.ts";
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

type CaptureImportCandidate = {
  readonly candidate: ImportCandidate;
  readonly imageText: unknown;
  readonly model: string;
  readonly reviewDecision: CaptureImportReviewDecision;
};
type CaptureImportResult =
  | Awaited<ReturnType<typeof importBottleCandidate>>
  | {
      readonly kind: "needs_review";
      readonly matchResult: Awaited<ReturnType<typeof matchBottleCandidate>>;
      readonly reason: "ocr_human_review_required";
      readonly reviewReasons: readonly string[];
    };

export class BottleCaptureWorkflow extends WorkflowEntrypoint<
  Bindings,
  BottleCaptureWorkflowParams
> {
  public override async run(
    event: Readonly<WorkflowEvent<BottleCaptureWorkflowParams>>,
    step: WorkflowStep,
  ): Promise<unknown> {
    const captureId = event.payload.captureId;
    let failedStage = "start capture workflow";
    let runContext: CaptureRunContext | null = null;

    try {
      if (
        !(await markCaptureExtracting({
          captureId,
          env: this.env,
          step,
          workflowInstanceId: event.instanceId,
        }))
      ) {
        return { captureId, status: "skipped" };
      }

      failedStage = "create capture run";
      runContext = await createCaptureRunContext({
        captureId,
        env: this.env,
        step,
        workflowInstanceId: event.instanceId,
      });
      const context = runContext;

      failedStage = "extract label evidence";
      const extractorResults = await runExtractorSteps({
        captureId,
        context,
        env: this.env,
        step,
      });
      const extractors = extractorsFromCaptureResults(extractorResults);

      failedStage = "reconcile extractor evidence";
      const reconciliation = await runReconciliationStep({
        captureId,
        context,
        env: this.env,
        extractors,
        step,
      });

      failedStage = "build import candidate";
      const extracted = buildCaptureImportCandidate({
        combined: reconciliation.combined,
        extractors,
      });

      failedStage = "write extraction artifact";
      const extractionArtifact = await writeExtractionArtifact({
        captureId,
        context,
        env: this.env,
        extracted,
        extractorResults,
        reconciliation,
        step,
      });
      const importCandidate = compactImportCandidate(extracted.candidate);

      failedStage = "import capture candidate";
      const imported = await importCaptureCandidateStep({
        captureId,
        context,
        env: this.env,
        extracted,
        step,
        workflowInstanceId: event.instanceId,
      });

      failedStage = "record capture result";
      await recordCaptureResult({
        captureId,
        context,
        env: this.env,
        extracted,
        extractionArtifact,
        importCandidate,
        imported,
        step,
        workflowInstanceId: event.instanceId,
      });

      return { captureId, status: imported.kind };
    } catch (error) {
      const database = createD1Client(this.env.DB);
      const message = shortErrorMessage(error, failedStage);
      const errorDetailArtifact =
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
          ...(errorDetailArtifact === null ? {} : { errorDetailArtifact }),
        });
      }
      await updateCaptureStatus({
        captureId,
        database,
        status: "failed",
        workflowInstanceId: event.instanceId,
        errorMessage: message,
        errorDetail: runContext === null ? errorDetails(error) : null,
      });
      return { captureId, failedStage, status: "failed" };
    }
  }
}

async function markCaptureExtracting({
  captureId,
  env,
  step,
  workflowInstanceId,
}: {
  readonly captureId: string;
  readonly env: Bindings;
  readonly step: WorkflowStep;
  readonly workflowInstanceId: string;
}): Promise<boolean> {
  return step.do("mark capture extracting", async () => {
    const database = createD1Client(env.DB);
    return beginCaptureWorkflow({
      captureId,
      database,
      workflowInstanceId,
    });
  });
}

async function createCaptureRunContext({
  captureId,
  env,
  step,
  workflowInstanceId,
}: {
  readonly captureId: string;
  readonly env: Bindings;
  readonly step: WorkflowStep;
  readonly workflowInstanceId: string;
}): Promise<CaptureRunContext> {
  return step.do("create capture run", async () => {
    const database = createD1Client(env.DB);
    const capture = await getCaptureForWorkflow({ captureId, database });
    const run = await createCaptureRun({
      captureId,
      database,
      runId: `run_${workflowInstanceId}`,
      status: "extracting",
    });
    return { capture, runId: run.runId };
  });
}

async function runExtractorSteps({
  captureId,
  context,
  env,
  step,
}: {
  readonly captureId: string;
  readonly context: CaptureRunContext;
  readonly env: Bindings;
  readonly step: WorkflowStep;
}): Promise<readonly CaptureExtractorResult[]> {
  const results: CaptureExtractorResult[] = [];
  // Each model call prepares image buffers and serializes a request. Keep only
  // one such payload in memory while retaining separate durable retry steps.
  for (const extractor of defaultBottleExtractorConfigs) {
    results.push(await runExtractorStep({ captureId, context, env, extractor, step }));
  }
  return results;
}

async function runExtractorStep({
  captureId,
  context,
  env,
  extractor,
  step,
}: {
  readonly captureId: string;
  readonly context: CaptureRunContext;
  readonly env: Bindings;
  readonly extractor: (typeof defaultBottleExtractorConfigs)[number];
  readonly step: WorkflowStep;
}): Promise<CaptureExtractorResult> {
  const extractorId = bottleExtractorId(extractor);
  return step.do(
    `extract label evidence with ${extractorId}`,
    {
      retries: {
        limit: 1,
        delay: "5 minutes",
        backoff: "constant",
      },
      timeout: "8 minutes",
    },
    async () => {
      const diagnostics: BottleOcrDiagnostic[] = [];
      try {
        const extracted = await extractCaptureLabelEvidence({
          bucket: env.IMAGE_BUCKET,
          images: env.IMAGES,
          capture: context.capture,
          diagnostics,
          extractor,
          gatewayToken: env.CF_AIG_TOKEN,
          gatewayUrl: env.AI_GATEWAY_URL,
        });
        logInfo("bottle_capture_extractor_completed", {
          captureId,
          diagnosticCount: diagnostics.length,
          extractorId: extracted.extractorId,
          model: extracted.model,
          runId: context.runId,
          siteId: context.capture.siteId,
        });
        return { ...extracted, diagnostics };
      } catch (error) {
        logError("bottle_capture_extractor_failed", {
          captureId,
          diagnostics,
          error: errorDetails(error),
          extractorId,
          model: extractor.model,
          runId: context.runId,
          siteId: context.capture.siteId,
        });
        throw error;
      }
    },
  );
}

async function runReconciliationStep({
  captureId,
  context,
  env,
  extractors,
  step,
}: {
  readonly captureId: string;
  readonly context: CaptureRunContext;
  readonly env: Bindings;
  readonly extractors: Parameters<typeof reconcileCaptureLabelEvidence>[0]["extractors"];
  readonly step: WorkflowStep;
}): Promise<CaptureReconciliationResult> {
  return step.do(
    "reconcile extractor evidence",
    {
      retries: {
        limit: 1,
        delay: "5 minutes",
        backoff: "constant",
      },
      timeout: "8 minutes",
    },
    async (): Promise<CaptureReconciliationResult> => {
      const diagnostics: BottleOcrDiagnostic[] = [];
      try {
        const reconciled = await reconcileCaptureLabelEvidence({
          diagnostics,
          extractors,
          gatewayToken: env.CF_AIG_TOKEN,
          gatewayUrl: env.AI_GATEWAY_URL,
        });
        logInfo("bottle_capture_reconciliation_completed", {
          captureId,
          diagnosticCount: diagnostics.length,
          model: reconciled.model,
          runId: context.runId,
          siteId: context.capture.siteId,
        });
        return { ...reconciled, diagnostics };
      } catch (error) {
        logError("bottle_capture_reconciliation_failed", {
          captureId,
          diagnostics,
          error: errorDetails(error),
          runId: context.runId,
          siteId: context.capture.siteId,
        });
        throw error;
      }
    },
  );
}

async function writeExtractionArtifact({
  captureId,
  context,
  env,
  extracted,
  extractorResults,
  reconciliation,
  step,
}: {
  readonly captureId: string;
  readonly context: CaptureRunContext;
  readonly env: Bindings;
  readonly extracted: CaptureImportCandidate;
  readonly extractorResults: readonly CaptureExtractorResult[];
  readonly reconciliation: CaptureReconciliationResult;
  readonly step: WorkflowStep;
}): Promise<CaptureRunArtifact> {
  return step.do("write extraction artifact", async () => {
    const artifact = await putCaptureRunArtifact({
      bucket: env.IMAGE_BUCKET,
      captureId,
      kind: "extraction",
      runId: context.runId,
      siteId: context.capture.siteId,
      value: {
        captureId,
        extractors: extractorResults,
        imageText: extracted.imageText,
        importCandidate: extracted.candidate,
        model: extracted.model,
        reconciliation,
        reviewDecision: extracted.reviewDecision,
        runId: context.runId,
      },
    });
    await updateCaptureRun({
      database: createD1Client(env.DB),
      runId: context.runId,
      status: "extracting",
      extractionArtifact: artifact,
      importCandidate: compactImportCandidate(extracted.candidate),
      model: extracted.model,
    });
    return artifact;
  });
}

async function importCaptureCandidateStep({
  captureId,
  context,
  env,
  extracted,
  step,
  workflowInstanceId,
}: {
  readonly captureId: string;
  readonly context: CaptureRunContext;
  readonly env: Bindings;
  readonly extracted: CaptureImportCandidate;
  readonly step: WorkflowStep;
  readonly workflowInstanceId: string;
}): Promise<CaptureImportResult> {
  return step.do("import capture candidate", async () => {
    const database = createD1Client(env.DB);
    if (extracted.reviewDecision.kind === "needs_review") {
      return {
        kind: "needs_review",
        matchResult: await matchBottleCandidate({
          candidate: extracted.candidate,
          database,
          siteId: context.capture.siteId,
        }),
        reason: extracted.reviewDecision.reason,
        reviewReasons: extracted.reviewDecision.reasons,
      };
    }
    return importBottleCandidate({
      candidate: extracted.candidate,
      captureId,
      database,
      runId: context.runId,
      // Read identity from the event, not the cached run context: checkpoints
      // written by older deployments do not include workflowInstanceId.
      workflowInstanceId,
      quantity: context.capture.quantity,
      siteId: context.capture.siteId,
    });
  });
}

async function recordCaptureResult({
  captureId,
  context,
  env,
  extracted,
  extractionArtifact,
  importCandidate,
  imported,
  step,
  workflowInstanceId,
}: {
  readonly captureId: string;
  readonly context: CaptureRunContext;
  readonly env: Bindings;
  readonly extracted: CaptureImportCandidate;
  readonly extractionArtifact: CaptureRunArtifact;
  readonly importCandidate: ImportCandidate;
  readonly imported: CaptureImportResult;
  readonly step: WorkflowStep;
  readonly workflowInstanceId: string;
}): Promise<void> {
  await step.do("record capture result", async () => {
    const database = createD1Client(env.DB);
    await updateCaptureRun({
      database,
      runId: context.runId,
      status: imported.kind,
      extractionArtifact,
      importCandidate,
      importResult: imported,
      matchResult: imported.matchResult,
      model: extracted.model,
    });
    switch (imported.kind) {
      case "imported":
        await updateCaptureStatus({
          captureId,
          database,
          status: "imported",
          errorMessage: null,
          errorDetail: null,
          importedBottleIds: imported.bottleIds,
          workflowInstanceId,
        });
        break;
      case "needs_review":
        await updateCaptureStatus({
          captureId,
          database,
          status: "needs_review",
          workflowInstanceId,
        });
        break;
      case "skipped":
        break;
      default: {
        const exhaustive: never = imported;
        return exhaustive;
      }
    }
    return { captureId, status: imported.kind };
  });
}

function compactImportCandidate(
  candidate: CaptureImportCandidate["candidate"],
): CaptureImportCandidate["candidate"] {
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
      value: { captureId, error: errorDetails(error), failedStage, runId },
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
