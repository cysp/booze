import { bottleCaptures, type BoozeDatabase } from "@chikachow/booze-db";
import { and, asc, eq, sql } from "drizzle-orm";
import type { BottleCaptureWorkflowParams } from "./api/types.ts";
import { errorDetails, logError } from "./observability.ts";

const pendingStartupMessage =
  "Capture is queued, but extraction startup has not been confirmed. It will be tried again automatically.";
const maximumLaunchesPerPass = 50;

type CaptureWorkflow = Pick<Workflow<BottleCaptureWorkflowParams>, "createBatch">;

// A queued capture and its owner are the durable launch intent. D1 and
// Workflows cannot commit together: retry this same ID after every uncertain
// handoff, rather than marking it failed and allocating another active owner.
export async function ensureCaptureWorkflowStarted({
  captureId,
  database,
  workflow,
}: {
  readonly captureId: string;
  readonly database: BoozeDatabase;
  readonly workflow: CaptureWorkflow;
}): Promise<{ readonly workflowInstanceId: string | null; readonly errorMessage?: string }> {
  const [capture] = await database
    .select({
      status: bottleCaptures.status,
      workflowInstanceId: bottleCaptures.workflowInstanceId,
    })
    .from(bottleCaptures)
    .where(eq(bottleCaptures.id, captureId))
    .limit(1);
  if (capture === undefined) return { workflowInstanceId: null };
  const { workflowInstanceId } = capture;
  if (capture.status !== "queued") return { workflowInstanceId };
  const intent = and(
    eq(bottleCaptures.id, captureId),
    eq(bottleCaptures.status, "queued"),
    sql`${bottleCaptures.workflowInstanceId} IS ${workflowInstanceId}`,
  );
  // Rotate attempted intents even when the platform remains unavailable. This
  // gives later queued captures a turn in the bounded maintenance pass.
  const [attempt] = await database
    .update(bottleCaptures)
    .set({ updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(intent)
    .returning({ id: bottleCaptures.id });
  if (attempt === undefined) return { workflowInstanceId };
  try {
    if (workflowInstanceId === null) throw new Error("Queued capture has no Workflow owner");
    const result = await workflow.createBatch({
      instances: [{ id: workflowInstanceId, params: { captureId } }],
    });
    const confirmed =
      result.created.some((instance) => instance.id === workflowInstanceId) ||
      result.errors.some(
        (error) => error.index === 0 && error.id === workflowInstanceId && error.code === 10405,
      );
    if (!confirmed)
      throw new Error("Workflow creation was not confirmed", { cause: result.errors });
    await database
      .update(bottleCaptures)
      .set({ errorMessage: null, errorDetailJson: null })
      .where(intent);
    return { workflowInstanceId };
  } catch (error) {
    const details = errorDetails(error);
    logError("bottle_capture_workflow_start_unconfirmed", {
      captureId,
      workflowInstanceId,
      error: details,
    });
    await database
      .update(bottleCaptures)
      .set({ errorMessage: pendingStartupMessage, errorDetailJson: JSON.stringify(details) })
      .where(intent);
    return { workflowInstanceId, errorMessage: pendingStartupMessage };
  }
}

export async function startQueuedCaptureWorkflows({
  database,
  workflow,
}: {
  readonly database: BoozeDatabase;
  readonly workflow: CaptureWorkflow;
}): Promise<void> {
  const queued = await database
    .select({ captureId: bottleCaptures.id })
    .from(bottleCaptures)
    .where(eq(bottleCaptures.status, "queued"))
    .orderBy(asc(bottleCaptures.updatedAt), asc(bottleCaptures.id))
    .limit(maximumLaunchesPerPass);
  for (const { captureId } of queued) {
    try {
      await ensureCaptureWorkflowStarted({ captureId, database, workflow });
    } catch (error) {
      logError("bottle_capture_queued_start_failed", { captureId, error: errorDetails(error) });
    }
  }
}
