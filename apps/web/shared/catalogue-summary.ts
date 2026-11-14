import { z } from "zod";
import { captureCountsSchema } from "./capture-counts.ts";

export const catalogueSummarySchema = z
  .object({
    data: z
      .object({
        inStockBottleCount: z.number().int().nonnegative(),
        drinkQueueBottleCount: z.number().int().nonnegative(),
        captures: captureCountsSchema,
      })
      .readonly(),
  })
  .readonly();
export type CatalogueSummary = z.infer<typeof catalogueSummarySchema>["data"];
