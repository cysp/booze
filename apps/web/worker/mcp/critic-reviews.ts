import {
  criticReviews,
  reviewSources,
  siteMemberships,
  type createD1Client,
} from "@chikachow/booze-db";
import { and, eq, isNull, or } from "drizzle-orm";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import {
  createOrUpdateReviewSource,
  deleteCriticReview,
  listCriticReviews,
  listReviewSources,
  upsertCriticReview,
  type CriticReviewFact,
  type ReviewSourceResource,
} from "../api/critic-reviews.ts";
import { resolveWineVintageId } from "./catalogue.ts";
import { decodePageCursor, pageFromRows, rowsAfterCursor, type Page } from "../read-pagination.ts";
import { toolJson } from "./pagination.ts";
import {
  createReviewSourceInputSchema,
  createReviewSourceOutputSchema,
  criticReviewSummarySchema,
  deleteCriticReviewInputSchema,
  deleteCriticReviewOutputSchema,
  listCriticReviewsInputSchema,
  listReviewSourcesInputSchema,
  paginationOutputSchema,
  reviewSourceSummarySchema,
  upsertCriticReviewInputSchema,
  upsertCriticReviewOutputSchema,
} from "./schemas.ts";

const listReviewSourcesToolName = "cellar.list_review_sources";
const listCriticReviewsToolName = "cellar.list_critic_reviews";
const listReviewSourcesCursorSchema = z.strictObject({
  reviewSourceId: z.string(),
});
const listCriticReviewsCursorSchema = z.strictObject({
  reviewId: z.string(),
});

type ToolAnnotations = {
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
  readonly readOnlyHint: boolean;
};

export function registerCriticReviewTools({
  database,
  readOnlyToolAnnotations,
  server,
  userId,
  writeToolAnnotations,
}: {
  readonly database: ReturnType<typeof createD1Client>;
  readonly readOnlyToolAnnotations: ToolAnnotations;
  readonly server: McpServer;
  readonly userId: string;
  readonly writeToolAnnotations: ToolAnnotations;
}): void {
  server.registerTool(
    "cellar.list_review_sources",
    {
      annotations: readOnlyToolAnnotations,
      title: "List review sources",
      description: "List authorised critic review sources available for wine review facts.",
      inputSchema: listReviewSourcesInputSchema,
      outputSchema: {
        ...paginationOutputSchema,
        reviewSources: z.array(reviewSourceSummarySchema),
      },
    },
    async (input) => {
      const sources = await listReviewSourceSummaries({ database, input, userId });
      return toolJson({ reviewSources: sources.items, ...sources.metadata });
    },
  );

  server.registerTool(
    "cellar.create_review_source",
    {
      annotations: writeToolAnnotations,
      title: "Create review source",
      description: "Create or update one site-scoped critic review source.",
      inputSchema: createReviewSourceInputSchema,
      outputSchema: createReviewSourceOutputSchema.shape,
    },
    async (input) => {
      const result = await createOrUpdateReviewSource({
        database,
        input: {
          isActive: input.isActive,
          name: input.name,
          notes: input.notes ?? undefined,
          siteId: input.siteId,
          sourceType: input.sourceType,
          url: input.url ?? undefined,
        },
        source: "mcp",
        userId,
      });
      return toolJson({
        changed: result.affectedRecordCount !== 0,
        reviewSource: reviewSourceSummary(result.after),
      });
    },
  );

  server.registerTool(
    "cellar.list_critic_reviews",
    {
      annotations: readOnlyToolAnnotations,
      title: "List critic reviews",
      description: "List authorised critic review facts for wine vintages.",
      inputSchema: listCriticReviewsInputSchema,
      outputSchema: {
        criticReviews: z.array(criticReviewSummarySchema),
        ...paginationOutputSchema,
      },
    },
    async ({ wineId, ...input }) => {
      const wineVintageId =
        wineId === undefined ? undefined : await resolveWineVintageId({ database, userId, wineId });
      const reviews = await listCriticReviewSummaries({
        database,
        input: { wineId, ...input },
        userId,
        wineVintageId,
      });
      return toolJson({ criticReviews: reviews.items, ...reviews.metadata });
    },
  );

  server.registerTool(
    "cellar.upsert_critic_review",
    {
      annotations: writeToolAnnotations,
      title: "Upsert critic review",
      description: "Create or update one critic review fact for an authorised wine vintage.",
      inputSchema: upsertCriticReviewInputSchema,
      outputSchema: upsertCriticReviewOutputSchema.shape,
    },
    async (input) => upsertCriticReviewTool({ database, input, userId }),
  );

  server.registerTool(
    "cellar.delete_critic_review",
    {
      annotations: writeToolAnnotations,
      title: "Delete critic review",
      description: "Delete one authorised critic review fact.",
      inputSchema: deleteCriticReviewInputSchema,
      outputSchema: deleteCriticReviewOutputSchema.shape,
    },
    async ({ criticReviewId }) => {
      const result = await deleteCriticReview({
        database,
        reviewId: await resolveCriticReviewId({ criticReviewId, database, userId }),
        source: "mcp",
        userId,
      });
      return toolJson({ criticReview: criticReviewSummary(result.before), deleted: true });
    },
  );
}

async function upsertCriticReviewTool({
  database,
  input: { wineId, ...input },
  userId,
}: {
  readonly database: ReturnType<typeof createD1Client>;
  readonly input: z.infer<typeof upsertCriticReviewInputSchema>;
  readonly userId: string;
}): Promise<ReturnType<typeof toolJson>> {
  const wineVintageId = await resolveWineVintageId({ database, userId, wineId });
  const reviewSourceId =
    input.reviewSourceId === undefined
      ? undefined
      : await resolveReviewSourceId({ database, reviewSourceId: input.reviewSourceId, userId });
  const result = await upsertCriticReview({
    database,
    review: {
      notes: input.notes ?? undefined,
      provenance: input.provenance ?? undefined,
      ratingScale: input.ratingScale ?? undefined,
      ratingText: input.ratingText,
      ratingValue: input.ratingValue ?? undefined,
      reviewSourceId,
      reviewSourceName: input.reviewSourceName,
      reviewedAt: input.reviewedAt ?? undefined,
      sourceUrl: input.sourceUrl ?? undefined,
    },
    userId,
    wineVintageId,
    source: "mcp",
  });
  return toolJson({
    changed: result.affectedRecordCount !== 0,
    criticReview: criticReviewSummary(result.after),
  });
}

export async function listReviewSourceSummaries({
  database,
  input,
  userId,
}: {
  readonly database: ReturnType<typeof createD1Client>;
  readonly input: z.infer<typeof listReviewSourcesInputSchema>;
  readonly userId: string;
}): Promise<Page<z.infer<typeof reviewSourceSummarySchema>>> {
  const cursor = decodePageCursor({
    cursorSchema: listReviewSourcesCursorSchema,
    input,
    toolName: listReviewSourcesToolName,
  });
  const rows = (await listReviewSources({ database, siteId: input.siteId, userId })).filter(
    (source) => input.includeInactive || source.isActive,
  );
  const summaries = rows.map((source) => reviewSourceSummary(source));
  return pageFromRows({
    cursorForItem: (item) => ({ reviewSourceId: item.reviewSourceId }),
    input,
    items: rowsAfterCursor({
      cursor,
      cursorForItem: (item) => ({ reviewSourceId: item.reviewSourceId }),
      items: summaries,
    }),
    toolName: listReviewSourcesToolName,
  });
}

export async function listCriticReviewSummaries({
  database,
  input,
  userId,
  wineVintageId,
}: {
  readonly database: ReturnType<typeof createD1Client>;
  readonly input: z.infer<typeof listCriticReviewsInputSchema>;
  readonly userId: string;
  readonly wineVintageId?: string | undefined;
}): Promise<Page<z.infer<typeof criticReviewSummarySchema>>> {
  const cursor = decodePageCursor({
    cursorSchema: listCriticReviewsCursorSchema,
    input,
    toolName: listCriticReviewsToolName,
  });
  const rows = (await listCriticReviews({ database, userId, wineVintageId })).filter(
    (review) => input.siteId === undefined || review.siteId === input.siteId,
  );
  const summaries = rows.map((review) => criticReviewSummary(review));
  return pageFromRows({
    cursorForItem: (item) => ({ reviewId: item.criticReviewId }),
    input,
    items: rowsAfterCursor({
      cursor,
      cursorForItem: (item) => ({ reviewId: item.criticReviewId }),
      items: summaries,
    }),
    toolName: listCriticReviewsToolName,
  });
}

export async function resolveReviewSourceId({
  database,
  reviewSourceId,
  userId,
}: {
  readonly database: ReturnType<typeof createD1Client>;
  readonly reviewSourceId: string;
  readonly userId: string;
}): Promise<string> {
  const [source] = await database
    .select({ id: reviewSources.id })
    .from(reviewSources)
    .leftJoin(siteMemberships, eq(reviewSources.siteId, siteMemberships.siteId))
    .where(
      and(
        eq(reviewSources.id, reviewSourceId),
        or(isNull(reviewSources.siteId), eq(siteMemberships.userId, userId)),
      ),
    )
    .limit(1);
  if (source === undefined) {
    throw new HTTPException(404, { message: "Review source not found" });
  }
  return source.id;
}

export async function resolveCriticReviewId({
  criticReviewId,
  database,
  userId,
}: {
  readonly criticReviewId: string;
  readonly database: ReturnType<typeof createD1Client>;
  readonly userId: string;
}): Promise<string> {
  const [review] = await database
    .select({ id: criticReviews.id })
    .from(criticReviews)
    .innerJoin(siteMemberships, eq(criticReviews.siteId, siteMemberships.siteId))
    .where(and(eq(criticReviews.id, criticReviewId), eq(siteMemberships.userId, userId)))
    .limit(1);
  if (review === undefined) {
    throw new HTTPException(404, { message: "Critic review not found" });
  }
  return review.id;
}

export function reviewSourceSummary(
  source: ReviewSourceResource,
): z.infer<typeof reviewSourceSummarySchema> {
  return {
    isActive: source.isActive,
    notes: source.notes,
    reviewSource: source.name,
    reviewSourceId: source.id,
    site: source.siteName,
    siteId: source.siteId,
    sourceType: source.sourceType,
    url: source.url,
  };
}

export function criticReviewSummary(
  review: CriticReviewFact,
): z.infer<typeof criticReviewSummarySchema> {
  return {
    criticReviewId: review.id,
    notes: review.notes,
    provenance: review.provenance,
    ratingScale: review.ratingScale,
    ratingText: review.ratingText,
    ratingValue: review.ratingValue,
    reviewSource: review.reviewSourceName,
    reviewSourceId: review.reviewSourceId,
    reviewedAt: review.reviewedAt,
    siteId: review.siteId,
    sourceUrl: review.sourceUrl,
    wineId: review.wineVintageId,
  };
}
