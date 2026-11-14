import { z } from "zod";

export const captureCountsSchema = z.object({
  actionable: z.number().int().nonnegative(),
  processing: z.number().int().nonnegative(),
  imported: z.number().int().nonnegative(),
});

export type CaptureCounts = z.infer<typeof captureCountsSchema>;
