import { z } from "zod";

import { entityIdSchema } from "../shared/entity-id.ts";
import { readPageQuerySchema } from "./api/read-page-input.ts";

export const captureListQuerySchema = readPageQuerySchema.extend({
  // The action view includes captures still processing, as well as those needing a decision.
  view: z.enum(["action", "all"]).default("action"),
});

export type CaptureListQuery = z.infer<typeof captureListQuerySchema>;

export const captureStatusQuerySchema = z.object({
  captureIds: z.array(entityIdSchema).min(1).max(100),
});
