import { z } from "zod";

import { captureImageResourceSchema, captureResourceSchema } from "./capture-resources.ts";
import { readPageSchema } from "./read-pagination.ts";
import { captureCountsSchema } from "./capture-counts.ts";
export { captureCountsSchema, type CaptureCounts } from "./capture-counts.ts";

export const captureSummarySchema = captureResourceSchema
  .unwrap()
  .pick({
    id: true,
    siteId: true,
    siteName: true,
    storageLocationId: true,
    storageLocationName: true,
    positionHint: true,
    quantity: true,
    status: true,
    errorMessage: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    imageCount: z.number().int().nonnegative(),
    previewImage: captureImageResourceSchema
      .unwrap()
      .pick({ imageAssetId: true, imageUrl: true })
      .nullable(),
  })
  .readonly();

export type CaptureSummary = z.infer<typeof captureSummarySchema>;

export const capturePageSchema = readPageSchema.extend({
  data: z.array(captureSummarySchema).readonly(),
  counts: captureCountsSchema,
});

export type CapturePage = z.infer<typeof capturePageSchema>;

export const captureStatusSnapshotSchema = captureResourceSchema
  .unwrap()
  .pick({ id: true, status: true, updatedAt: true, errorMessage: true })
  .readonly();

export type CaptureStatusSnapshot = z.infer<typeof captureStatusSnapshotSchema>;

// Missing and inaccessible IDs are both omitted. A disappearance can invalidate
// inventory, but does not establish that the capture imported successfully.
export const captureStatusPageSchema = z.object({
  data: z.array(captureStatusSnapshotSchema).readonly(),
});
