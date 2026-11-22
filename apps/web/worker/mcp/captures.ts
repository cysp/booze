import type { CellarToolRegistration } from "./server.ts";
import { z } from "zod";
import { captureSummarySchema } from "../../shared/capture-read-resources.ts";
import { captureReviewCandidateResourceSchema } from "../../shared/capture-resources.ts";
import { captureReviewCandidateSchema } from "../../shared/capture-review.ts";
import { candidateValidationIssueSchema } from "../../shared/catalogue-inputs.ts";
import { entityIdSchema } from "../../shared/entity-id.ts";
import { getBottleCapture, listBottleCaptures, saveCaptureReview } from "../capture-store.ts";
import { toolJson } from "./pagination.ts";
import { paginationInputSchema, paginationOutputSchema } from "./schemas.ts";

const captureFields = captureSummarySchema
  .unwrap()
  .pick({
    siteId: true,
    siteName: true,
    storageLocationId: true,
    storageLocationName: true,
    positionHint: true,
    status: true,
    quantity: true,
    createdAt: true,
  })
  .extend({ captureId: entityIdSchema });

const extractedCandidateSchema = z.object({
  // Historical extraction facts can require correction before they meet today's input schema.
  wine: z.record(z.string(), z.unknown()),
  bottle: z.record(z.string(), z.unknown()),
});
const validationIssuesSchema = z.object({
  validationIssues: z.array(candidateValidationIssueSchema),
});
const reviewStateSchema = z.object({
  reviewRevision: z.number().int().nonnegative(),
  status: z.string(),
});

export function registerCaptureTools(
  {
    database,
    server,
    userId,
    readOnlyToolAnnotations,
    writeToolAnnotations,
  }: CellarToolRegistration,
  confirmationUrl: string,
): void {
  server.registerTool(
    "cellar.list_captures",
    {
      title: "List photo captures",
      description:
        "List authorised photo captures, newest first. Includes processing and unimported captures by default.",
      annotations: readOnlyToolAnnotations,
      inputSchema: z.strictObject({
        view: z.enum(["action", "all"]).default("action"),
        ...paginationInputSchema,
      }),
      outputSchema: { captures: z.array(captureFields), ...paginationOutputSchema },
    },
    async (input) => {
      const page = await listBottleCaptures({ database, userId, query: input });
      const captures = page.data.map((row) => captureFields.parse({ ...row, captureId: row.id }));
      return toolJson({
        captures,
        hasMore: page.nextPageToken !== null,
        limit: input.limit,
        nextPageToken: page.nextPageToken,
        returnedCount: captures.length,
      });
    },
  );

  server.registerTool(
    "cellar.get_capture_review",
    {
      title: "Get a photo capture draft",
      description:
        "Read the saved draft, original extracted wine and bottle facts, and original extraction issues. Use the saved candidate when present. A human confirms the reviewed wine and quantity in the browser's Captures screen.",
      annotations: readOnlyToolAnnotations,
      inputSchema: z.strictObject({ captureId: entityIdSchema }),
      outputSchema: captureFields.extend({
        reviewRevision: reviewStateSchema.shape.reviewRevision,
        reviewCandidate: captureReviewCandidateResourceSchema.nullable(),
        extractedCandidate: extractedCandidateSchema.nullable(),
        extractionIssues: z.array(candidateValidationIssueSchema),
        confirmationUrl: z
          .url()
          .describe("Open Captures here to review the wine and quantity in the browser."),
      }).shape,
    },
    async ({ captureId }) => {
      const capture = await getBottleCapture({ captureId, database, userId });
      const extraction = capture.latestRun?.importCandidate;
      const extracted = extractedCandidateSchema.safeParse(extraction);
      const issues = validationIssuesSchema.safeParse(extraction);
      return toolJson({
        ...captureFields.parse({ ...capture, captureId }),
        reviewRevision: capture.reviewRevision,
        reviewCandidate: capture.reviewCandidate,
        extractedCandidate: extracted.success ? extracted.data : null,
        extractionIssues: issues.success ? issues.data.validationIssues : [],
        confirmationUrl,
      });
    },
  );

  server.registerTool(
    "cellar.save_capture_review",
    {
      title: "Save photo capture corrections",
      description:
        "Replace the complete draft at its expected revision. Preserve untouched wine and bottle fields from the current draft. Saving creates no stock. Direct the user to Captures in the browser to confirm this capture.",
      annotations: writeToolAnnotations,
      inputSchema: z.strictObject({
        captureId: entityIdSchema,
        expectedRevision: reviewStateSchema.shape.reviewRevision,
        candidate: captureReviewCandidateSchema,
      }),
      outputSchema: {
        captureId: entityIdSchema,
        siteId: entityIdSchema,
        before: reviewStateSchema,
        after: reviewStateSchema,
        changed: z.boolean(),
        affectedRecordCount: z.number().int(),
        confirmationUrl: z
          .url()
          .describe("Open Captures here to review the wine and quantity in the browser."),
      },
    },
    async (input) =>
      toolJson({
        ...(await saveCaptureReview({ database, userId, source: "mcp" }, input)),
        confirmationUrl,
      }),
  );
}
