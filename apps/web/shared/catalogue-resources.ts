import { z } from "zod";

const text = z.string();
const number = z.number();
const nullableText = text.nullable();
const nullableNumber = number.nullable();

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

export const wineFactsResourceSchema = z.object({
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

export type {
  CaptureImageResource,
  CaptureRunResource,
  CaptureResource,
  CaptureReviewCandidateResource,
} from "./capture-resources.ts";
