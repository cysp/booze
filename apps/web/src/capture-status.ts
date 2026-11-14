import type { CaptureResource } from "./inventory-model.ts";

type CaptureStatusMeta = {
  readonly actionable: boolean;
  readonly badge: "neutral" | "info" | "success" | "warning" | "error";
  readonly deletable: boolean;
  readonly label: string;
};

const captureStatusMeta = {
  uploading: { actionable: false, badge: "info", deletable: true, label: "Uploading" },
  queued: { actionable: false, badge: "neutral", deletable: false, label: "Queued" },
  extracting: { actionable: false, badge: "info", deletable: false, label: "Extracting" },
  importing: { actionable: false, badge: "info", deletable: false, label: "Importing" },
  upload_failed: { actionable: true, badge: "error", deletable: true, label: "Upload failed" },
  needs_review: { actionable: true, badge: "warning", deletable: true, label: "Review" },
  imported: { actionable: false, badge: "success", deletable: true, label: "Imported" },
  failed: { actionable: true, badge: "error", deletable: true, label: "Failed" },
} satisfies Record<CaptureResource["status"], CaptureStatusMeta>;

export function captureStatus(status: CaptureResource["status"]): CaptureStatusMeta {
  return captureStatusMeta[status];
}
