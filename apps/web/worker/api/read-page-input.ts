import { z } from "zod";

export const readPageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  pageToken: z.string().min(1).optional(),
});
