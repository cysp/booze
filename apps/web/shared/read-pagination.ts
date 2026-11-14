import { z } from "zod";

export const readPageSchema = z.object({
  totalCount: z.number().int().nonnegative(),
  nextPageToken: z.string().nullable(),
});
