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

export function isCaptureStatus(value: unknown): value is CaptureStatus {
  return typeof value === "string" && captureStatuses.some((status) => status === value);
}
