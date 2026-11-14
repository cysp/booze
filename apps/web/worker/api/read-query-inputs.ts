import { z } from "zod";
import { entityIdSchema } from "../../shared/entity-id.ts";
import { drinkStatusSchema } from "../../shared/inventory-queries.ts";
import { readPageQuerySchema } from "./read-page-input.ts";

export const inventoryQuerySchema = readPageQuerySchema.extend({
  query: z.string().trim().max(500).optional(),
  siteId: entityIdSchema.optional(),
  storageLocationId: entityIdSchema.optional(),
  grapeVariety: z.string().min(1).optional(),
  drinkStatus: drinkStatusSchema.optional(),
  drinkQueue: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .default(false),
  status: z.enum(["in_stock", "consumed", "any"]).default("in_stock"),
});
export type InventoryQuery = z.infer<typeof inventoryQuerySchema>;

export const wineOptionsQuerySchema = readPageQuerySchema.extend({
  siteId: entityIdSchema.optional(),
  query: z.string().trim().max(500).optional(),
});
export type WineOptionsQuery = z.infer<typeof wineOptionsQuerySchema>;
