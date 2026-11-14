import { z } from "zod";
import { bottleResourceSchema } from "./catalogue-resources.ts";
import { drinkStatuses } from "./drink-status.ts";
import { readPageSchema } from "./read-pagination.ts";

export const drinkStatusSchema = z.enum(drinkStatuses);
export type { DrinkStatus } from "./drink-status.ts";

export const bottleSummarySchema = bottleResourceSchema
  .unwrap()
  .pick({
    id: true,
    wineVintageId: true,
    wineryId: true,
    wineBottleCount: true,
    siteId: true,
    siteName: true,
    storageLocationId: true,
    storageLocationName: true,
    positionHint: true,
    status: true,
    bottleNumber: true,
    volumeMl: true,
    wineryName: true,
    brandName: true,
    displayName: true,
    vintageYear: true,
    vintageStatus: true,
    vintageLabel: true,
    grapeVarieties: true,
    country: true,
    region: true,
    appellation: true,
    alcoholPercent: true,
    drinkFromYear: true,
    drinkToYear: true,
    createdAt: true,
  })
  .readonly();
export type BottleSummary = z.infer<typeof bottleSummarySchema>;

export const inventoryPageSchema = readPageSchema
  .extend({
    data: z.array(bottleSummarySchema).readonly(),
    facets: z
      .object({
        grapeVarieties: z.array(z.string()).readonly(),
        drinkStatuses: z.array(drinkStatusSchema).readonly(),
      })
      .readonly(),
  })
  .readonly();
export type InventoryPage = z.infer<typeof inventoryPageSchema>;
