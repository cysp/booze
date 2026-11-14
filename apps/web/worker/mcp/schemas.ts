import { z } from "zod";

export const drinkStatusSchema = z.enum([
  "drink-now",
  "drink-soon",
  "hold",
  "past-window",
  "unknown",
]);

export const drinkQueueStatuses = ["drink-now", "drink-soon", "past-window"] as const;

const paginationInputSchema = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(25)
    .default(10)
    .describe("Maximum records to return. Defaults to 10 and cannot exceed 25."),
  pageToken: z
    .string()
    .trim()
    .min(1)
    .max(16_384)
    .optional()
    .describe("Opaque token from a previous page. Pass it back unchanged to fetch the next page."),
};

const siteIdInputSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .describe("Authorised storage site ID returned by cellar.list_sites or other cellar tools.");
const storageLocationIdInputSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .describe(
    "MCP storage location ID returned as storageLocationId by cellar.list_storage_locations.",
  );
const wineIdInputSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .describe("MCP wine vintage ID returned as wineId by cellar.list_wines or bottle summary tools.");
const bottleIdInputSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .describe("Bottle ID returned as bottleId by wine search, list, or queue tools.");
const searchQueryInputSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .describe("Case-insensitive text to match against display names and searchable fields.");
const drinkYearInputSchema = z.number().int().min(1800).max(2200);
const reviewSourceIdInputSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .describe("MCP review source ID returned by cellar.list_review_sources.");
const criticReviewIdInputSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .describe("MCP critic review ID returned by cellar.list_critic_reviews.");

export const searchBottlesInputSchema = z.strictObject({
  query: searchQueryInputSchema.optional(),
  siteId: siteIdInputSchema.optional(),
  locationId: storageLocationIdInputSchema.optional(),
  winery: z
    .string()
    .trim()
    .min(1)
    .max(160)
    .optional()
    .describe("Case-insensitive winery name filter."),
  wine: z.string().trim().min(1).max(180).optional().describe("Case-insensitive wine name filter."),
  grapeVariety: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .optional()
    .describe("Case-insensitive grape variety filter."),
  region: z.string().trim().min(1).max(160).optional().describe("Case-insensitive region filter."),
  vintageYear: drinkYearInputSchema.optional().describe("Exact vintage year filter."),
  drinkStatus: drinkStatusSchema.optional().describe("Exact calculated drink-status filter."),
  ...paginationInputSchema,
});

export const listSitesInputSchema = z.strictObject({
  query: searchQueryInputSchema.optional(),
  ...paginationInputSchema,
});

export const locationInventoryInputSchema = z.strictObject({
  locationId: storageLocationIdInputSchema,
  ...paginationInputSchema,
});

export const createStorageLocationInputSchema = z.strictObject({
  siteId: siteIdInputSchema,
  parentStorageLocationId: storageLocationIdInputSchema
    .nullable()
    .optional()
    .describe("Optional MCP parent storage location ID, or null for a top-level location."),
  name: z.string().trim().min(1).max(120).describe("Storage location name."),
  locationType: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .default("area")
    .describe("Storage location type. Defaults to area."),
});

export const getBottleInputSchema = z.strictObject({
  bottleId: bottleIdInputSchema,
});

export const listStorageLocationsInputSchema = z.strictObject({
  query: searchQueryInputSchema.optional(),
  siteId: siteIdInputSchema.optional(),
  ...paginationInputSchema,
});

export const listWinesInputSchema = z.strictObject({
  query: searchQueryInputSchema.optional(),
  siteId: siteIdInputSchema.optional(),
  winery: z
    .string()
    .trim()
    .min(1)
    .max(160)
    .optional()
    .describe("Case-insensitive winery name filter."),
  brand: z
    .string()
    .trim()
    .min(1)
    .max(160)
    .optional()
    .describe("Case-insensitive brand name filter."),
  wine: z.string().trim().min(1).max(180).optional().describe("Case-insensitive wine name filter."),
  grapeVariety: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .optional()
    .describe("Case-insensitive grape variety filter."),
  region: z.string().trim().min(1).max(160).optional().describe("Case-insensitive region filter."),
  vintageYear: drinkYearInputSchema.optional().describe("Exact vintage year filter."),
  ...paginationInputSchema,
});

export const getWineInputSchema = z.strictObject({
  wineId: wineIdInputSchema,
});

export const listReviewSourcesInputSchema = z.strictObject({
  siteId: siteIdInputSchema.optional(),
  includeInactive: z
    .boolean()
    .default(false)
    .describe("Whether inactive review sources are included."),
  ...paginationInputSchema,
});

export const createReviewSourceInputSchema = z.strictObject({
  siteId: siteIdInputSchema,
  name: z.string().trim().min(1).max(160).describe("Review source name."),
  sourceType: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .default("critic")
    .describe("Source type. Defaults to critic."),
  url: z.string().trim().max(500).nullable().optional().describe("Optional source home URL."),
  notes: z.string().trim().max(1_000).nullable().optional().describe("User-authored source notes."),
  isActive: z.boolean().default(true).describe("Whether this source can be used for new reviews."),
});

export const listCriticReviewsInputSchema = z.strictObject({
  wineId: wineIdInputSchema.optional(),
  siteId: siteIdInputSchema.optional(),
  ...paginationInputSchema,
});

export const upsertCriticReviewInputSchema = z.strictObject({
  wineId: wineIdInputSchema,
  reviewSourceId: reviewSourceIdInputSchema.optional(),
  reviewSourceName: z
    .string()
    .trim()
    .min(1)
    .max(160)
    .optional()
    .describe("Review source name to create or reuse when reviewSourceId is not supplied."),
  ratingText: z
    .string()
    .trim()
    .min(1)
    .max(160)
    .describe("Source-expressed rating, such as 95 points, 4 stars, Gold, or Recommended."),
  ratingValue: z
    .number()
    .min(0)
    .max(1000)
    .nullable()
    .optional()
    .describe("Optional numeric value for the source-expressed rating."),
  ratingScale: z
    .string()
    .trim()
    .max(80)
    .nullable()
    .optional()
    .describe("Optional source-expressed scale, such as 100 points or 5 stars."),
  sourceUrl: z.string().trim().max(500).nullable().optional().describe("Optional review URL."),
  reviewedAt: z
    .string()
    .trim()
    .max(80)
    .nullable()
    .optional()
    .describe("Optional source review date or edition label."),
  provenance: z
    .string()
    .trim()
    .max(500)
    .nullable()
    .optional()
    .describe("Optional provenance for where this fact came from."),
  notes: z
    .string()
    .trim()
    .max(1_000)
    .nullable()
    .optional()
    .describe("Optional user-authored notes. Do not copy full critic prose by default."),
});

export const deleteCriticReviewInputSchema = z.strictObject({
  criticReviewId: criticReviewIdInputSchema,
});

export const listWineriesInputSchema = z.strictObject({
  query: searchQueryInputSchema.optional(),
  siteId: siteIdInputSchema.optional(),
  brand: z
    .string()
    .trim()
    .min(1)
    .max(160)
    .optional()
    .describe("Case-insensitive brand name filter."),
  region: z.string().trim().min(1).max(160).optional().describe("Case-insensitive region filter."),
  country: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .optional()
    .describe("Case-insensitive country filter."),
  ...paginationInputSchema,
});

export const listDrinkQueueInputSchema = z.strictObject({
  drinkStatuses: z
    .array(drinkStatusSchema)
    .min(1)
    .max(drinkStatusSchema.options.length)
    .default([...drinkQueueStatuses])
    .describe(
      "Calculated drink statuses to include. Defaults to drink-now, drink-soon, and past-window.",
    ),
  ...paginationInputSchema,
});

export const setDrinkingWindowInputSchema = z
  .strictObject({
    wineId: wineIdInputSchema,
    drinkFromYear: drinkYearInputSchema
      .nullable()
      .describe("First drinking-window year, or null to clear the start year."),
    drinkToYear: drinkYearInputSchema
      .nullable()
      .describe("Final drinking-window year, or null to clear the end year."),
  })
  .refine(
    (input) =>
      input.drinkFromYear === null ||
      input.drinkToYear === null ||
      input.drinkFromYear <= input.drinkToYear,
    { message: "drinkFromYear must be less than or equal to drinkToYear" },
  );

export const setBottleLocationInputSchema = z.strictObject({
  bottleId: bottleIdInputSchema,
  storageLocationId: storageLocationIdInputSchema
    .nullable()
    .describe("MCP storage location ID, or null to clear the bottle location."),
  position: z
    .string()
    .trim()
    .max(120)
    .nullable()
    .optional()
    .describe("Optional position hint within the storage location, or null to clear it."),
});

export const markBottleConsumedInputSchema = z.strictObject({
  bottleId: bottleIdInputSchema,
});

const nullableStringSchema = z.string().nullable();
const nullableNumberSchema = z.number().nullable();
const nullableYearSchema = z.number().int().min(1800).max(2200).nullable();
const siteIdOutputSchema = z.string().describe("Authorised storage site ID.");
const wineIdOutputSchema = z.string().describe("MCP wine vintage ID.");
const wineryIdOutputSchema = z.string().describe("MCP winery ID.");
const storageLocationIdOutputSchema = z
  .string()
  .nullable()
  .describe("MCP storage location ID, or null when unset.");
const reviewSourceIdOutputSchema = z.string().describe("MCP review source ID.");
const criticReviewIdOutputSchema = z.string().describe("MCP critic review ID.");

export const bottleOutputSchema = {
  addressQualification: nullableStringSchema,
  alcoholPercent: nullableNumberSchema,
  appellation: nullableStringSchema,
  barcode: nullableStringSchema,
  baseName: z.string(),
  bottleId: z.string(),
  bottleNotes: nullableStringSchema,
  bottleNumber: nullableStringSchema,
  brand: nullableStringSchema,
  classification: nullableStringSchema,
  country: nullableStringSchema,
  createdAt: z.string(),
  description: nullableStringSchema,
  designation: nullableStringSchema,
  drinkFromYear: nullableYearSchema,
  drinkStatus: drinkStatusSchema,
  drinkToYear: nullableYearSchema,
  drinkingAdvice: nullableStringSchema,
  grapeVarieties: z.array(z.string()),
  labelText: nullableStringSchema,
  lotCode: nullableStringSchema,
  position: nullableStringSchema,
  region: nullableStringSchema,
  site: z.string(),
  siteId: siteIdOutputSchema,
  sourceUrl: nullableStringSchema,
  status: z.string(),
  storageLocation: nullableStringSchema,
  storageLocationId: storageLocationIdOutputSchema,
  vintageLabel: z.string(),
  vintageYear: nullableYearSchema,
  volumeMl: z.number().int().min(1),
  wine: z.string(),
  wineColor: nullableStringSchema,
  wineNotes: nullableStringSchema,
  wineType: nullableStringSchema,
  wineId: wineIdOutputSchema,
  winery: z.string(),
  wineryId: wineryIdOutputSchema.nullable(),
};

export const bottleSummaryOutputSchema = {
  bottleId: z.string(),
  bottleNumber: nullableStringSchema,
  brand: nullableStringSchema,
  drinkFromYear: nullableYearSchema,
  drinkStatus: drinkStatusSchema,
  drinkToYear: nullableYearSchema,
  grapeVarieties: z.array(z.string()),
  position: nullableStringSchema,
  region: nullableStringSchema,
  site: z.string(),
  siteId: siteIdOutputSchema,
  storageLocation: nullableStringSchema,
  storageLocationId: storageLocationIdOutputSchema,
  vintageLabel: z.string(),
  vintageYear: nullableYearSchema,
  wine: z.string(),
  wineColor: nullableStringSchema,
  wineType: nullableStringSchema,
  wineId: wineIdOutputSchema,
  winery: z.string(),
  wineryId: wineryIdOutputSchema.nullable(),
};

export const paginationOutputSchema = {
  hasMore: z.boolean(),
  limit: z.number().int().min(1),
  nextPageToken: z.string().nullable(),
  returnedCount: z.number().int().min(0),
};

export const bottleSummaryListOutputSchema = {
  bottles: z.array(z.object(bottleSummaryOutputSchema)),
  ...paginationOutputSchema,
};

export const bottleDetailSchema = z.object(bottleOutputSchema);

export const siteSummarySchema = z.object({
  bottleCount: z.number().int().min(0),
  inStockBottleCount: z.number().int().min(0),
  locationCount: z.number().int().min(0),
  site: z.string(),
  siteId: siteIdOutputSchema,
});

export const storageLocationSummarySchema = z.object({
  bottleCount: z.number().int().min(0),
  parentStorageLocationId: storageLocationIdOutputSchema,
  site: z.string(),
  siteId: siteIdOutputSchema,
  storageLocation: z.string(),
  storageLocationId: z.string().describe("MCP storage location ID."),
  storageLocationType: z.string(),
});

export const wineVintageSummaryOutputSchema = {
  baseName: z.string(),
  bottleCount: z.number().int().min(0),
  brand: nullableStringSchema,
  drinkFromYear: nullableYearSchema,
  drinkStatus: drinkStatusSchema,
  drinkToYear: nullableYearSchema,
  grapeVarieties: z.array(z.string()),
  inStockBottleCount: z.number().int().min(0),
  region: nullableStringSchema,
  site: z.string(),
  siteId: siteIdOutputSchema,
  vintageLabel: z.string(),
  vintageYear: nullableYearSchema,
  wine: z.string(),
  wineColor: nullableStringSchema,
  wineType: nullableStringSchema,
  wineId: wineIdOutputSchema,
  winery: z.string(),
  wineryId: wineryIdOutputSchema.nullable(),
};

export const wineVintageSummarySchema = z.object(wineVintageSummaryOutputSchema);

export const reviewSourceSummarySchema = z.object({
  isActive: z.boolean(),
  notes: nullableStringSchema,
  reviewSource: z.string(),
  reviewSourceId: reviewSourceIdOutputSchema,
  site: nullableStringSchema,
  siteId: siteIdOutputSchema.nullable(),
  sourceType: z.string(),
  url: nullableStringSchema,
});

export const criticReviewSummarySchema = z.object({
  criticReviewId: criticReviewIdOutputSchema,
  notes: nullableStringSchema,
  provenance: nullableStringSchema,
  ratingScale: nullableStringSchema,
  ratingText: z.string(),
  ratingValue: nullableNumberSchema,
  reviewSource: z.string(),
  reviewSourceId: reviewSourceIdOutputSchema,
  reviewedAt: nullableStringSchema,
  siteId: siteIdOutputSchema,
  sourceUrl: nullableStringSchema,
  wineId: wineIdOutputSchema,
});

export const createReviewSourceOutputSchema = z.object({
  changed: z.boolean(),
  reviewSource: reviewSourceSummarySchema,
});

export const upsertCriticReviewOutputSchema = z.object({
  changed: z.boolean(),
  criticReview: criticReviewSummarySchema,
});

export const deleteCriticReviewOutputSchema = z.object({
  criticReview: criticReviewSummarySchema,
  deleted: z.boolean(),
});

export const winerySummaryOutputSchema = {
  brands: z.array(z.string()),
  country: nullableStringSchema,
  inStockBottleCount: z.number().int().min(0),
  region: nullableStringSchema,
  site: z.string(),
  siteId: siteIdOutputSchema,
  wineVintageCount: z.number().int().min(0),
  winery: z.string(),
  wineryId: wineryIdOutputSchema,
};

export const winerySummarySchema = z.object(winerySummaryOutputSchema);

export const inventorySummarySchema = z.object({
  bottleStatusCounts: z.array(
    z.object({
      bottleStatus: z.string(),
      count: z.number().int().min(0),
      site: z.string(),
      siteId: siteIdOutputSchema,
    }),
  ),
  drinkStatusCounts: z.array(
    z.object({
      count: z.number().int().min(0),
      drinkStatus: drinkStatusSchema,
      site: z.string(),
      siteId: siteIdOutputSchema,
    }),
  ),
  sites: z.array(siteSummarySchema),
});

const mutationResultFields = {
  changed: z.boolean(),
  affectedRecordCount: z.number().int().nonnegative(),
};
const locationMutationFactsSchema = z.object({
  id: z.string(),
  siteId: z.string(),
  parentId: z.string().nullable(),
  name: z.string(),
  locationType: z.string(),
  notes: z.string().nullable(),
});
export const createStorageLocationOutputSchema = z.object({
  ...mutationResultFields,
  before: locationMutationFactsSchema.nullable(),
  after: locationMutationFactsSchema,
});
const bottleMutationFactsSchema = z.object({
  bottleId: z.string(),
  siteId: z.string(),
  wineVintageId: z.string(),
  status: z.string(),
  storageLocationId: z.string().nullable(),
  positionHint: z.string().nullable(),
});
export const setBottleLocationOutputSchema = z.object({
  ...mutationResultFields,
  before: bottleMutationFactsSchema,
  after: bottleMutationFactsSchema.nullable(),
});
export const markBottleConsumedOutputSchema = setBottleLocationOutputSchema;
const wineWindowFactsSchema = z.object({
  id: z.string(),
  siteId: z.string(),
  drinkFromYear: z.number().nullable(),
  drinkToYear: z.number().nullable(),
  bottleCount: z.number().int().nonnegative(),
});
export const setDrinkingWindowOutputSchema = z.object({
  ...mutationResultFields,
  affectedBottleCount: z.number().int().nonnegative(),
  before: wineWindowFactsSchema,
  after: wineWindowFactsSchema,
});
