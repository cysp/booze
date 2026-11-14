import { z } from "zod";

const text = (max: number) => z.string().trim().max(max).nullable().optional();
const year = z.number().int().min(1800).max(2200).nullable().optional();

const wineFields = z.object({
  wineryName: z.string().trim().max(160),
  brandName: text(160),
  baseName: text(180),
  designation: text(160),
  displayName: text(180),
  vintageYear: year,
  vintageStatus: z.enum(["year", "non_vintage", "unknown"]).optional(),
  grapeVarieties: z.array(z.string().trim().min(1).max(120)).max(24).readonly().optional(),
  country: text(120),
  region: text(160),
  appellation: text(160),
  classification: text(160),
  wineType: text(120),
  wineColor: text(40),
  addressQualification: text(500),
  alcoholPercent: z.number().min(0).max(100).nullable().optional(),
  drinkFromYear: year,
  drinkToYear: year,
  description: text(2_000),
  drinkingAdvice: text(2_000),
  labelText: text(4_000),
  sourceUrl: z
    .union([z.url().trim().max(500), z.literal("")])
    .nullable()
    .optional(),
  notes: text(2_000),
});

type WineFields = z.infer<typeof wineFields>;

function validateWineConsistency(
  wine: Pick<WineFields, "vintageYear" | "vintageStatus" | "drinkFromYear" | "drinkToYear">,
  context: z.RefinementCtx,
) {
  const hasYear = wine.vintageYear !== undefined && wine.vintageYear !== null;
  if (
    (wine.vintageStatus === "year" && !hasYear) ||
    (hasYear && wine.vintageStatus !== undefined && wine.vintageStatus !== "year")
  ) {
    context.addIssue({
      code: "custom",
      path: ["vintageYear"],
      message: "Choose a year, non-vintage, or unknown vintage without contradictory values.",
    });
  }
  if (
    wine.drinkFromYear !== undefined &&
    wine.drinkFromYear !== null &&
    wine.drinkToYear !== undefined &&
    wine.drinkToYear !== null &&
    wine.drinkFromYear > wine.drinkToYear
  ) {
    context.addIssue({
      code: "custom",
      path: ["drinkToYear"],
      message: "Drink window must end on or after it starts.",
    });
  }
}

export const wineInputSchema = wineFields.superRefine(validateWineConsistency);

export const winePatchInputSchema = wineFields.partial().superRefine((wine, context) => {
  if ((wine.drinkFromYear === undefined) !== (wine.drinkToYear === undefined)) {
    context.addIssue({
      code: "custom",
      path: ["drinkToYear"],
      message: "Edit drinkFromYear and drinkToYear together; use null for an unknown endpoint.",
    });
  }
  // A patch may retain an existing year when it changes only vintageStatus.
  // Validate the complete merged vintage when the operation prepares the wine.
  if (wine.vintageStatus === "year" && wine.vintageYear === undefined) {
    validateWineConsistency({ ...wine, vintageStatus: undefined }, context);
  } else {
    validateWineConsistency(wine, context);
  }
});

export const bottleInputSchema = z.object({
  bottleNumber: z.string().trim().max(80).optional(),
  volumeMl: z.number().int().min(1).max(30_000).optional(),
  barcode: z.string().trim().max(80).optional(),
  lotCode: z.string().trim().max(120).optional(),
  notes: z.string().trim().max(2_000).optional(),
});

export const bottleQuantitySchema = z.number().int().min(1).max(24);

export const candidateValidationIssueSchema = z.object({
  path: z.string(),
  rawValue: z.string(),
  message: z.string(),
});

export const catalogueCandidateSchema = z.object({
  wine: wineFields
    .extend({
      wineryName: wineFields.shape.wineryName.default(""),
      designation: wineFields.shape.designation.default(""),
    })
    .superRefine(validateWineConsistency),
  bottle: bottleInputSchema,
});

export type WineInput = z.infer<typeof wineInputSchema>;
export type WinePatchInput = z.infer<typeof winePatchInputSchema>;
export type BottleInput = z.infer<typeof bottleInputSchema>;
export type CatalogueCandidate = z.infer<typeof catalogueCandidateSchema>;
export type CandidateValidationIssue = z.infer<typeof candidateValidationIssueSchema>;
