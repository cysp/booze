export const captureStatuses = [
  "uploading",
  "queued",
  "extracting",
  "importing",
  "upload_failed",
  "needs_review",
  "imported",
  "failed",
] as const;

export type CaptureStatus = (typeof captureStatuses)[number];

export const processingCaptureStatuses = [
  "uploading",
  "queued",
  "extracting",
  "importing",
] as const;
export const actionableCaptureStatuses = ["upload_failed", "needs_review", "failed"] as const;

export function isProcessingCaptureStatus(status: CaptureStatus): boolean {
  return processingCaptureStatuses.some((value) => value === status);
}

export function isActionableCaptureStatus(status: CaptureStatus): boolean {
  return actionableCaptureStatuses.some((value) => value === status);
}

export function isCaptureStatus(value: unknown): value is CaptureStatus {
  return typeof value === "string" && captureStatuses.some((status) => status === value);
}
