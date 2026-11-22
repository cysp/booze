import { z } from "zod";

const captureArtifactContentType = "application/json";

export type CaptureRunArtifactKind = "error" | "extraction" | "reviewed-extraction";

type CaptureArtifactBucket = {
  readonly put: (
    key: string,
    value: string,
    options: { readonly httpMetadata: { readonly contentType: string } },
  ) => Promise<unknown>;
};

export type CaptureRunArtifact = {
  readonly contentType: string;
  readonly r2Key: string;
  readonly sizeBytes: number;
};

export function captureRunArtifactKey({
  captureId,
  kind,
  runId,
  siteId,
}: {
  readonly captureId: string;
  readonly kind: CaptureRunArtifactKind;
  readonly runId: string;
  readonly siteId: string;
}): string {
  return `sites/${siteId}/captures/${captureId}/runs/${runId}/${kind}.json`;
}

export type RetainedCaptureExtraction = {
  readonly artifact: CaptureRunArtifact;
  readonly draft: {
    readonly candidate: Readonly<Record<string, unknown>>;
    readonly reviewReasons: readonly string[];
  };
};

// Old Workflow checkpoints can outlive the Worker that wrote their reconciled
// draft. Reuse the candidate and reasons from the exact retained object.
export async function readLegacyCaptureExtraction({
  bucket,
  captureId,
  runId,
  siteId,
}: {
  readonly bucket: R2Bucket;
  readonly captureId: string;
  readonly runId: string;
  readonly siteId: string;
}): Promise<RetainedCaptureExtraction | null> {
  const r2Key = captureRunArtifactKey({ captureId, runId, siteId, kind: "extraction" });
  const object = await bucket.get(r2Key);
  if (object === null) return null;
  const retained = z
    .object({
      captureId: z.literal(captureId),
      runId: z.literal(runId),
      importCandidate: z.looseObject({
        wine: z.record(z.string(), z.unknown()),
        bottle: z.record(z.string(), z.unknown()),
      }),
      reviewDecision: z.object({ reasons: z.array(z.string()) }),
    })
    .parse(await object.json<unknown>());
  return {
    artifact: { r2Key, sizeBytes: object.size, contentType: captureArtifactContentType },
    draft: {
      candidate: { ...retained.importCandidate, rawSuggestion: {} },
      reviewReasons: retained.reviewDecision.reasons,
    },
  };
}

export async function putCaptureRunArtifact({
  bucket,
  captureId,
  kind,
  runId,
  siteId,
  value,
}: {
  readonly bucket: CaptureArtifactBucket;
  readonly captureId: string;
  readonly kind: CaptureRunArtifactKind;
  readonly runId: string;
  readonly siteId: string;
  readonly value: unknown;
}): Promise<CaptureRunArtifact> {
  const r2Key = captureRunArtifactKey({ captureId, kind, runId, siteId });
  const body = JSON.stringify(value);
  if (body === undefined) {
    throw new Error("Capture artifact value must be JSON serializable");
  }
  const sizeBytes = new TextEncoder().encode(body).byteLength;
  await bucket.put(r2Key, body, { httpMetadata: { contentType: captureArtifactContentType } });
  return { contentType: captureArtifactContentType, r2Key, sizeBytes };
}
