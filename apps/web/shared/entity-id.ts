import { z } from "zod";

// Persisted IDs are opaque: validation must not normalize or truncate them.
export const entityIdSchema = z.string().min(1);
