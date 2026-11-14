import { z } from "zod";
import { bottleResourceSchema } from "./catalogue-resources.ts";
import { wineOptionSchema } from "./wine-options.ts";
import { readPageSchema } from "./read-pagination.ts";

export const wineOptionsPageSchema = readPageSchema
  .extend({
    data: z.array(wineOptionSchema).readonly(),
  })
  .readonly();
export type WineOptionsPage = z.infer<typeof wineOptionsPageSchema>;

export const wineResourceSchema = bottleResourceSchema
  .unwrap()
  .pick({
    id: true,
    siteId: true,
    siteName: true,
    wineryId: true,
    wineryName: true,
    brandName: true,
    baseName: true,
    designation: true,
    displayName: true,
    vintageYear: true,
    vintageStatus: true,
    vintageLabel: true,
    grapeVarieties: true,
    country: true,
    region: true,
    appellation: true,
    classification: true,
    wineType: true,
    wineColor: true,
    addressQualification: true,
    alcoholPercent: true,
    drinkFromYear: true,
    drinkToYear: true,
    description: true,
    drinkingAdvice: true,
    labelText: true,
    sourceUrl: true,
    wineNotes: true,
    criticReviews: true,
    awards: true,
  })
  .extend({
    bottleCount: z.number(),
    inStockBottleCount: z.number(),
  })
  .readonly();
export type WineResource = z.infer<typeof wineResourceSchema>;
export const wineDetailResponseSchema = z.object({ data: wineResourceSchema }).readonly();
