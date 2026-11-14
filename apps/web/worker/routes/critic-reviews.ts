import { createD1Client } from "@chikachow/booze-db";
import { Hono } from "hono";
import { z } from "zod";
import { entityIdSchema } from "../../shared/entity-id.ts";

import { requireAuthenticatedUser } from "../api/auth.ts";
import {
  createOrUpdateReviewSource,
  criticReviewInputSchema,
  deleteCriticReview,
  listCriticReviews,
  listReviewSources,
  replaceCriticReviewsForWine,
  upsertCriticReview,
} from "../api/critic-reviews.ts";
import { readRequestJson } from "../api/request-body.ts";
import type { Bindings } from "../api/types.ts";

const reviewSourceInputSchema = z.object({
  siteId: entityIdSchema,
  name: z.string().trim().min(1).max(160),
  sourceType: z.string().trim().min(1).max(80).default("critic"),
  url: z.url().trim().max(500).optional().or(z.literal("")),
  notes: z.string().trim().max(1_000).optional(),
  isActive: z.boolean().default(true),
});

const listReviewSourcesSchema = z.object({
  siteId: entityIdSchema.optional(),
});

const listCriticReviewsSchema = z.object({
  wineVintageId: entityIdSchema.optional(),
});

const upsertCriticReviewSchema = z.object({
  wineVintageId: entityIdSchema,
  review: criticReviewInputSchema,
});

const replaceCriticReviewsSchema = z.object({
  siteId: entityIdSchema,
  wineVintageId: entityIdSchema,
  reviews: z.array(criticReviewInputSchema).max(24),
});

export const criticReviewRoutes = new Hono<{ Bindings: Bindings }>()
  .get("/review-sources", async (context) => {
    const query = listReviewSourcesSchema.parse({
      siteId: context.req.query("siteId"),
    });
    const database = createD1Client(context.env.DB);
    const authenticatedUser = await requireAuthenticatedUser({
      database,
      request: context.req.raw,
      headers: context.req.raw.headers,
      secretKey: context.env.CLERK_SECRET_KEY,
    });
    const sources = await listReviewSources({
      database,
      siteId: query.siteId,
      userId: authenticatedUser.userId,
    });
    return context.json({ data: sources });
  })
  .post("/review-sources", async (context) => {
    const payload = reviewSourceInputSchema.parse(await readRequestJson(context.req.raw));
    const database = createD1Client(context.env.DB);
    const authenticatedUser = await requireAuthenticatedUser({
      database,
      request: context.req.raw,
      headers: context.req.raw.headers,
      secretKey: context.env.CLERK_SECRET_KEY,
    });
    const source = await createOrUpdateReviewSource({
      database,
      input: payload,
      userId: authenticatedUser.userId,
      source: "http",
    });
    return context.json({ data: source }, 201);
  })
  .get("/critic-reviews", async (context) => {
    const query = listCriticReviewsSchema.parse({
      wineVintageId: context.req.query("wineVintageId"),
    });
    const database = createD1Client(context.env.DB);
    const authenticatedUser = await requireAuthenticatedUser({
      database,
      request: context.req.raw,
      headers: context.req.raw.headers,
      secretKey: context.env.CLERK_SECRET_KEY,
    });
    const reviews = await listCriticReviews({
      database,
      wineVintageId: query.wineVintageId,
      userId: authenticatedUser.userId,
    });
    return context.json({ data: reviews });
  })
  .put("/critic-reviews", async (context) => {
    const payload = upsertCriticReviewSchema.parse(await readRequestJson(context.req.raw));
    const database = createD1Client(context.env.DB);
    const authenticatedUser = await requireAuthenticatedUser({
      database,
      request: context.req.raw,
      headers: context.req.raw.headers,
      secretKey: context.env.CLERK_SECRET_KEY,
    });
    const review = await upsertCriticReview({
      database,
      review: payload.review,
      userId: authenticatedUser.userId,
      wineVintageId: payload.wineVintageId,
      source: "http",
    });
    return context.json({ data: review });
  })
  .put("/wines/:wineVintageId/critic-reviews", async (context) => {
    const payload = {
      ...replaceCriticReviewsSchema
        .omit({ wineVintageId: true })
        .parse(await readRequestJson(context.req.raw)),
      wineVintageId: context.req.param("wineVintageId"),
    };
    const database = createD1Client(context.env.DB);
    const authenticatedUser = await requireAuthenticatedUser({
      database,
      request: context.req.raw,
      headers: context.req.raw.headers,
      secretKey: context.env.CLERK_SECRET_KEY,
    });
    const reviews = await replaceCriticReviewsForWine({
      database,
      reviews: payload.reviews,
      siteId: payload.siteId,
      userId: authenticatedUser.userId,
      wineVintageId: payload.wineVintageId,
      source: "http",
    });
    return context.json({ data: reviews });
  })
  .delete("/critic-reviews/:reviewId", async (context) => {
    const database = createD1Client(context.env.DB);
    const authenticatedUser = await requireAuthenticatedUser({
      database,
      request: context.req.raw,
      headers: context.req.raw.headers,
      secretKey: context.env.CLERK_SECRET_KEY,
    });
    await deleteCriticReview({
      database,
      reviewId: context.req.param("reviewId"),
      source: "http",
      userId: authenticatedUser.userId,
    });
    return new Response(null, { status: 204 });
  });
