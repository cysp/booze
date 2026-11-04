import {
  criticReviews,
  reviewSources,
  siteMemberships,
  sites,
  wineVintages,
  type BoozeDatabase,
} from "@chikachow/booze-db";
import { and, asc, eq, isNull, notInArray, or, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";

import { requireSitePermission } from "./auth.ts";
import { retryCatalogueTransaction } from "./catalogue-transaction.ts";
import { generatedId, optionalText } from "./ids.ts";

type ReviewStatement = Parameters<BoozeDatabase["batch"]>[0][number];
type ReviewMutationAudit<Resource> = (change: {
  readonly before: Resource | undefined;
  readonly after: Resource;
}) => ReviewStatement;

export type ReviewSourceInput = {
  readonly siteId: string;
  readonly name: string;
  readonly sourceType?: string | undefined;
  readonly url?: string | undefined;
  readonly notes?: string | undefined;
  readonly isActive?: boolean | undefined;
};

export type CriticReviewInput = {
  readonly id?: string | undefined;
  readonly reviewSourceId?: string | undefined;
  readonly reviewSourceName?: string | undefined;
  readonly ratingText: string;
  readonly ratingValue?: number | undefined;
  readonly ratingScale?: string | undefined;
  readonly sourceUrl?: string | undefined;
  readonly reviewedAt?: string | undefined;
  readonly provenance?: string | undefined;
  readonly notes?: string | undefined;
};

export type ReviewSourceResource = {
  readonly id: string;
  readonly siteId: string | null;
  readonly siteName: string | null;
  readonly name: string;
  readonly sourceType: string;
  readonly url: string | null;
  readonly notes: string | null;
  readonly isActive: boolean;
};

export type CriticReviewResource = {
  readonly id: string;
  readonly siteId: string;
  readonly wineVintageId: string;
  readonly reviewSourceId: string;
  readonly reviewSourceName: string;
  readonly ratingText: string;
  readonly ratingValue: number | null;
  readonly ratingScale: string | null;
  readonly sourceUrl: string | null;
  readonly reviewedAt: string | null;
  readonly provenance: string | null;
  readonly notes: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type CriticReviewFact = Omit<CriticReviewResource, "createdAt" | "updatedAt">;

export async function listReviewSources({
  database,
  siteId,
  userId,
}: {
  readonly database: BoozeDatabase;
  readonly siteId?: string | undefined;
  readonly userId: string;
}): Promise<readonly ReviewSourceResource[]> {
  const rows = await database
    .select({
      id: reviewSources.id,
      siteId: reviewSources.siteId,
      siteName: sites.name,
      name: reviewSources.name,
      sourceType: reviewSources.sourceType,
      url: reviewSources.url,
      notes: reviewSources.notes,
      isActive: reviewSources.isActive,
    })
    .from(reviewSources)
    .leftJoin(sites, eq(reviewSources.siteId, sites.id))
    .leftJoin(siteMemberships, eq(reviewSources.siteId, siteMemberships.siteId))
    .where(
      and(
        or(isNull(reviewSources.siteId), eq(siteMemberships.userId, userId)),
        siteId === undefined
          ? undefined
          : or(isNull(reviewSources.siteId), eq(reviewSources.siteId, siteId)),
      ),
    )
    .orderBy(asc(reviewSources.name));

  return rows;
}

export async function createOrUpdateReviewSource({
  database,
  audit,
  input,
  userId,
}: {
  readonly database: BoozeDatabase;
  readonly audit?: ReviewMutationAudit<ReviewSourceResource> | undefined;
  readonly input: ReviewSourceInput;
  readonly userId: string;
}): Promise<ReviewSourceResource> {
  await requireSitePermission({
    database,
    permission: "site.content.write",
    siteId: input.siteId,
    userId,
  });

  const site = await database
    .select({ name: sites.name })
    .from(sites)
    .where(eq(sites.id, input.siteId))
    .limit(1);
  if (site[0] === undefined) throw new HTTPException(404, { message: "Site not found" });
  const siteName = site[0].name;
  return retryCatalogueTransaction(async () => {
    const before = (await listReviewSources({ database, siteId: input.siteId, userId })).find(
      (source) => source.siteId === input.siteId && source.name === input.name.trim(),
    );
    const after: ReviewSourceResource = {
      id: before?.id ?? generatedId("review-source"),
      siteId: input.siteId,
      siteName,
      name: input.name.trim(),
      sourceType: optionalText(input.sourceType) ?? "critic",
      url: optionalText(input.url),
      notes: optionalText(input.notes),
      isActive: input.isActive ?? true,
    };
    const write = createReviewSourceUpsert({ database, input, reviewSourceId: after.id });
    await database.batch([write, ...(audit === undefined ? [] : [audit({ before, after })])]);
    return after;
  });
}

function createReviewSourceUpsert({
  database,
  input,
  reviewSourceId,
}: {
  readonly database: BoozeDatabase;
  readonly input: ReviewSourceInput;
  readonly reviewSourceId: string;
}): ReviewStatement {
  const name = input.name.trim();
  return database
    .insert(reviewSources)
    .values({
      id: reviewSourceId,
      siteId: input.siteId,
      name,
      sourceType: optionalText(input.sourceType) ?? "critic",
      url: optionalText(input.url),
      notes: optionalText(input.notes),
      isActive: input.isActive ?? true,
    })
    .onConflictDoUpdate({
      // New natural-key conflicts must roll back so every dependent statement
      // can be rebuilt with the winning stored ID, including audit targets.
      target: reviewSources.id,
      set: {
        sourceType: optionalText(input.sourceType) ?? "critic",
        url: optionalText(input.url),
        notes: optionalText(input.notes),
        isActive: input.isActive ?? true,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      },
    });
}

export async function listCriticReviews({
  database,
  wineVintageId,
  userId,
}: {
  readonly database: BoozeDatabase;
  readonly wineVintageId?: string | undefined;
  readonly userId: string;
}): Promise<readonly CriticReviewResource[]> {
  const rows = await database
    .select(criticReviewColumns())
    .from(criticReviews)
    .innerJoin(siteMemberships, eq(criticReviews.siteId, siteMemberships.siteId))
    .innerJoin(reviewSources, eq(criticReviews.reviewSourceId, reviewSources.id))
    .where(
      and(
        eq(siteMemberships.userId, userId),
        wineVintageId === undefined ? undefined : eq(criticReviews.wineVintageId, wineVintageId),
      ),
    )
    .orderBy(asc(reviewSources.name), asc(criticReviews.ratingText));

  return rows.map((row) => criticReviewFromRow(row));
}

export async function replaceCriticReviewsForWine({
  database,
  reviews,
  siteId,
  userId,
  wineVintageId,
}: {
  readonly database: BoozeDatabase;
  readonly reviews: readonly CriticReviewInput[];
  readonly siteId: string;
  readonly userId: string;
  readonly wineVintageId: string;
}): Promise<readonly CriticReviewResource[]> {
  await requireSitePermission({
    database,
    permission: "site.content.write",
    siteId,
    userId,
  });
  await assertWineVintageInSite({ database, siteId, wineVintageId });

  await retryCatalogueTransaction(async () => {
    const statements = await prepareCriticReviewStatements({
      database,
      reviews,
      siteId,
      userId,
      wineVintageId,
    });
    const [first, ...rest] = statements;
    if (first !== undefined) await database.batch([first, ...rest]);
  });
  return listCriticReviews({ database, userId, wineVintageId });
}

export async function prepareCriticReviewStatements(
  input: Omit<Parameters<typeof prepareCriticReviewChanges>[0], "audit">,
): Promise<ReviewStatement[]> {
  return (await prepareCriticReviewChanges(input)).statements;
}

async function prepareCriticReviewChanges({
  audit,
  database,
  reviews,
  siteId,
  userId,
  wineVintageId,
  removeMissing = true,
  overwriteExisting = true,
}: {
  readonly audit?: ReviewMutationAudit<CriticReviewFact> | undefined;
  readonly database: BoozeDatabase;
  readonly reviews: readonly CriticReviewInput[];
  readonly siteId: string;
  readonly userId: string;
  readonly wineVintageId: string;
  readonly removeMissing?: boolean;
  readonly overwriteExisting?: boolean;
}): Promise<{ readonly statements: ReviewStatement[]; readonly facts: CriticReviewFact[] }> {
  const statements: ReviewStatement[] = [];
  const facts: CriticReviewFact[] = [];
  const sources = [...(await listReviewSources({ database, siteId, userId }))];
  const existing: CriticReviewFact[] = [
    ...(await listCriticReviews({ database, userId, wineVintageId })),
  ];
  const keptReviewSourceIds: string[] = [];
  for (const review of reviews) {
    let source =
      review.reviewSourceId === undefined
        ? sources.find(
            (candidate) =>
              candidate.siteId === siteId && candidate.name === review.reviewSourceName?.trim(),
          )
        : sources.find((candidate) => candidate.id === review.reviewSourceId);
    if (source === undefined) {
      if (review.reviewSourceId !== undefined || optionalText(review.reviewSourceName) === null) {
        throw new HTTPException(400, { message: "Review source is not available for this site" });
      }
      const name = review.reviewSourceName?.trim() ?? "";
      source = {
        id: generatedId("review-source"),
        siteId,
        siteName: null,
        name,
        sourceType: "critic",
        url: null,
        notes: null,
        isActive: true,
      };
      sources.push(source);
      statements.push(
        database
          .insert(reviewSources)
          .values({ id: source.id, siteId, name, sourceType: "critic", isActive: true }),
      );
    }
    if (!source.isActive)
      throw new HTTPException(400, { message: "Review source is not available for this site" });
    keptReviewSourceIds.push(source.id);
    const previous = existing.find((candidate) => candidate.reviewSourceId === source.id);
    if (previous !== undefined && !overwriteExisting) continue;
    const reviewId = previous?.id ?? generatedId("critic-review");
    const after: CriticReviewFact = {
      ...criticReviewValues(review),
      id: reviewId,
      siteId,
      wineVintageId,
      reviewSourceId: source.id,
      reviewSourceName: source.name,
    };
    existing.push(after);
    facts.push(after);
    statements.push(
      createCriticReviewUpsert({
        database,
        overwriteExisting,
        review,
        reviewId,
        reviewSourceId: source.id,
        siteId,
        userId,
        wineVintageId,
      }),
    );
    if (audit !== undefined) statements.push(audit({ before: previous, after }));
  }
  if (removeMissing) {
    statements.push(
      database
        .delete(criticReviews)
        .where(
          and(
            eq(criticReviews.siteId, siteId),
            eq(criticReviews.wineVintageId, wineVintageId),
            keptReviewSourceIds.length === 0
              ? undefined
              : notInArray(criticReviews.reviewSourceId, keptReviewSourceIds),
          ),
        ),
    );
  }
  return { statements, facts };
}

function createCriticReviewUpsert({
  database,
  overwriteExisting = true,
  review,
  reviewId,
  reviewSourceId,
  siteId,
  userId,
  wineVintageId,
}: {
  readonly database: BoozeDatabase;
  readonly overwriteExisting?: boolean;
  readonly review: CriticReviewInput;
  readonly reviewId: string;
  readonly reviewSourceId: string;
  readonly siteId: string;
  readonly userId: string;
  readonly wineVintageId: string;
}): ReviewStatement {
  const statement = database.insert(criticReviews).values({
    id: reviewId,
    siteId,
    wineVintageId,
    reviewSourceId,
    ...criticReviewValues(review),
    createdByUserId: userId,
  });
  return overwriteExisting
    ? statement.onConflictDoUpdate({
        target: criticReviews.id,
        set: {
          ...criticReviewValues(review),
          updatedAt: sql`CURRENT_TIMESTAMP`,
        },
      })
    : statement.onConflictDoNothing({
        target: [criticReviews.siteId, criticReviews.wineVintageId, criticReviews.reviewSourceId],
      });
}

function criticReviewValues(review: CriticReviewInput) {
  return {
    ratingText: review.ratingText.trim(),
    ratingValue: review.ratingValue ?? null,
    ratingScale: optionalText(review.ratingScale),
    sourceUrl: optionalText(review.sourceUrl),
    reviewedAt: optionalText(review.reviewedAt),
    provenance: optionalText(review.provenance),
    notes: optionalText(review.notes),
  };
}

export async function upsertCriticReview({
  audit,
  database,
  review,
  userId,
  wineVintageId,
}: {
  readonly audit?: ReviewMutationAudit<CriticReviewFact> | undefined;
  readonly database: BoozeDatabase;
  readonly review: CriticReviewInput;
  readonly userId: string;
  readonly wineVintageId: string;
}): Promise<CriticReviewResource> {
  const wine = await authorisedWineVintage({ database, userId, wineVintageId });
  await requireSitePermission({
    database,
    permission: "site.content.write",
    siteId: wine.siteId,
    userId,
  });
  const reviewId = await retryCatalogueTransaction(async () => {
    const { statements, facts } = await prepareCriticReviewChanges({
      audit,
      database,
      reviews: [review],
      siteId: wine.siteId,
      userId,
      wineVintageId,
      removeMissing: false,
    });
    const [first, ...rest] = statements;
    const fact = facts[0];
    if (first === undefined || fact === undefined)
      throw new Error("Critic review requires a write");
    await database.batch([first, ...rest]);
    return fact.id;
  });
  const reviews = await listCriticReviews({ database, userId, wineVintageId });
  const result = reviews.find((candidate) => candidate.id === reviewId);
  if (result === undefined) {
    throw new Error("Critic review upsert did not return a row");
  }
  return result;
}

export async function deleteCriticReview({
  database,
  reviewId,
  userId,
}: {
  readonly database: BoozeDatabase;
  readonly reviewId: string;
  readonly userId: string;
}): Promise<CriticReviewResource> {
  const rows = await database
    .select(criticReviewColumns())
    .from(criticReviews)
    .innerJoin(siteMemberships, eq(criticReviews.siteId, siteMemberships.siteId))
    .innerJoin(reviewSources, eq(criticReviews.reviewSourceId, reviewSources.id))
    .where(and(eq(criticReviews.id, reviewId), eq(siteMemberships.userId, userId)))
    .limit(1);
  const review = rows[0] === undefined ? undefined : criticReviewFromRow(rows[0]);
  if (review === undefined) {
    throw new HTTPException(404, { message: "Critic review not found" });
  }
  await requireSitePermission({
    database,
    permission: "site.content.write",
    siteId: review.siteId,
    userId,
  });

  await database.delete(criticReviews).where(eq(criticReviews.id, reviewId));
  return review;
}

async function assertWineVintageInSite({
  database,
  siteId,
  wineVintageId,
}: {
  readonly database: BoozeDatabase;
  readonly siteId: string;
  readonly wineVintageId: string;
}): Promise<void> {
  const rows = await database
    .select({ id: wineVintages.id })
    .from(wineVintages)
    .where(and(eq(wineVintages.siteId, siteId), eq(wineVintages.id, wineVintageId)))
    .limit(1);
  if (rows[0] === undefined) {
    throw new HTTPException(404, { message: "Wine vintage not found" });
  }
}

async function authorisedWineVintage({
  database,
  userId,
  wineVintageId,
}: {
  readonly database: BoozeDatabase;
  readonly userId: string;
  readonly wineVintageId: string;
}): Promise<{ readonly siteId: string }> {
  const rows = await database
    .select({ siteId: wineVintages.siteId })
    .from(wineVintages)
    .innerJoin(siteMemberships, eq(wineVintages.siteId, siteMemberships.siteId))
    .where(and(eq(wineVintages.id, wineVintageId), eq(siteMemberships.userId, userId)))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    throw new HTTPException(404, { message: "Wine vintage not found" });
  }
  return row;
}

function criticReviewColumns() {
  return {
    id: criticReviews.id,
    siteId: criticReviews.siteId,
    wineVintageId: criticReviews.wineVintageId,
    reviewSourceId: criticReviews.reviewSourceId,
    reviewSourceName: reviewSources.name,
    ratingText: criticReviews.ratingText,
    ratingValue: criticReviews.ratingValue,
    ratingScale: criticReviews.ratingScale,
    sourceUrl: criticReviews.sourceUrl,
    reviewedAt: criticReviews.reviewedAt,
    provenance: criticReviews.provenance,
    notes: criticReviews.notes,
    createdAt: criticReviews.createdAt,
    updatedAt: criticReviews.updatedAt,
  };
}

function criticReviewFromRow(row: CriticReviewResource): CriticReviewResource {
  return row;
}
