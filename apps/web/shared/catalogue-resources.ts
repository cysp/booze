import { z } from "zod";

const text = z.string();
const number = z.number();
const nullableText = text.nullable();
const nullableNumber = number.nullable();

import { captureStatuses } from "./capture-status.ts";

// Response schemas describe stored representations. New-entry limits belong to input schemas.

export const criticReviewResourceSchema = z
  .object({
    id: text,
    siteId: text,
    wineVintageId: text,
    reviewSourceId: text,
    reviewSourceName: text,
    ratingText: text,
    ratingValue: nullableNumber,
    ratingScale: nullableText,
    sourceUrl: nullableText,
    reviewedAt: nullableText,
    provenance: nullableText,
    notes: nullableText,
    createdAt: text,
    updatedAt: text,
  })
  .readonly();

export type CriticReviewResource = z.infer<typeof criticReviewResourceSchema>;

export const wineAwardResourceSchema = z
  .object({
    id: text,
    siteId: text,
    wineVintageId: text,
    awardName: text,
    awardLevel: text,
    awardYear: nullableNumber,
    awardBody: nullableText,
    category: nullableText,
    points: nullableNumber,
    sourceUrl: nullableText,
    provenance: nullableText,
    notes: nullableText,
    createdAt: text,
    updatedAt: text,
  })
  .readonly();

export type WineAwardResource = z.infer<typeof wineAwardResourceSchema>;

const wineFactsResourceSchema = z.object({
  wineryName: text,
  brandName: nullableText,
  baseName: text,
  designation: nullableText,
  displayName: text,
  vintageYear: nullableNumber,
  vintageStatus: z.enum(["year", "non_vintage", "unknown"]),
  grapeVarieties: z.array(text).readonly(),
  country: nullableText,
  region: nullableText,
  appellation: nullableText,
  classification: nullableText,
  wineType: nullableText,
  wineColor: nullableText,
  addressQualification: nullableText,
  alcoholPercent: nullableNumber,
  drinkFromYear: nullableNumber,
  drinkToYear: nullableNumber,
  description: nullableText,
  drinkingAdvice: nullableText,
  labelText: nullableText,
  sourceUrl: nullableText,
});

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

export const bottleResourceSchema = z
  .object({
    ...wineFactsResourceSchema.shape,
    id: text,
    wineVintageId: text,
    wineryId: nullableText,
    wineBottleCount: number,
    siteId: text,
    siteName: text,
    storageLocationId: nullableText,
    storageLocationName: nullableText,
    positionHint: nullableText,
    status: text,
    bottleNumber: nullableText,
    volumeMl: number,
    barcode: nullableText,
    lotCode: nullableText,
    bottleNotes: nullableText,
    vintageLabel: text,
    wineNotes: nullableText,
    criticReviews: z.array(criticReviewResourceSchema).readonly(),
    awards: z.array(wineAwardResourceSchema).readonly(),
    createdAt: text,
  })
  .readonly();

export type BottleResource = z.infer<typeof bottleResourceSchema>;

export const storageLocationResourceSchema = z
  .object({
    id: text,
    siteId: text,
    siteName: text,
    parentId: nullableText,
    name: text,
    locationType: text,
    bottleCount: number,
  })
  .readonly();

export type StorageLocationResource = z.infer<typeof storageLocationResourceSchema>;

export const siteResourceSchema = z
  .object({
    id: text,
    name: text,
    bottleCount: number,
    locationCount: number,
    role: z.enum(["owner", "editor", "viewer"]),
  })
  .readonly();

export type SiteResource = z.infer<typeof siteResourceSchema>;

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
