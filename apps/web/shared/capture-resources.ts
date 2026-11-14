import { z } from "zod";
import { captureStatuses } from "./capture-status.ts";
import { wineFactsResourceSchema } from "./catalogue-resources.ts";

const text = z.string();
const number = z.number();
const nullableText = text.nullable();
const nullableNumber = number.nullable();

// Stored capture details are loaded only when a capture is opened.

export const captureReviewCandidateResourceSchema = z
  .object({
    wine: wineFactsResourceSchema
      .partial()
      .required({ wineryName: true, designation: true })
      .extend({
        baseName: nullableText.optional(),
        displayName: nullableText.optional(),
        notes: nullableText.optional(),
      }),
    bottle: z.object({
      bottleNumber: text.optional(),
      volumeMl: number.optional(),
      barcode: text.optional(),
      lotCode: text.optional(),
      notes: text.optional(),
    }),
  })
  .readonly();

export type CaptureReviewCandidateResource = z.infer<typeof captureReviewCandidateResourceSchema>;

export const captureImageResourceSchema = z
  .object({
    imageAssetId: text,
    originalFilename: nullableText,
    sortOrder: number,
    contentType: text,
    sizeBytes: number,
    imageUrl: text,
  })
  .readonly();

export type CaptureImageResource = z.infer<typeof captureImageResourceSchema>;

export const captureRunResourceSchema = z
  .object({
    id: text,
    status: text,
    extractionR2Key: nullableText,
    extractionContentType: nullableText,
    extractionSizeBytes: nullableNumber,
    importCandidate: z.unknown(),
    matchResult: z.unknown(),
    importResult: z.unknown(),
    errorMessage: nullableText,
    errorDetailR2Key: nullableText,
    errorDetailContentType: nullableText,
    errorDetailSizeBytes: nullableNumber,
    createdAt: text,
    completedAt: nullableText,
  })
  .readonly();

export type CaptureRunResource = z.infer<typeof captureRunResourceSchema>;

export const captureResourceSchema = z
  .object({
    id: text,
    siteId: text,
    siteName: text,
    storageLocationId: nullableText,
    storageLocationName: nullableText,
    positionHint: nullableText,
    quantity: number,
    status: z.enum(captureStatuses),
    workflowInstanceId: nullableText,
    importedBottleIds: z.array(text).readonly(),
    errorMessage: nullableText,
    createdAt: text,
    updatedAt: text,
    images: z.array(captureImageResourceSchema).readonly(),
    latestRun: captureRunResourceSchema.nullable(),
    reviewCandidate: captureReviewCandidateResourceSchema.nullable(),
    reviewRevision: number,
  })
  .readonly();

export type CaptureResource = z.infer<typeof captureResourceSchema>;
