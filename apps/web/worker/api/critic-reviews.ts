import {
  criticReviews,
  reviewSources,
  siteMemberships,
  sites,
  wineVintages,
  type BoozeDatabase,
} from "@chikachow/booze-db";
import { and, asc, eq, isNull, notInArray, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { HTTPException } from "hono/http-exception";

import {
  commitOperation,
  createOperationAudit,
  operationAuditResultSchema,
  operationConstraintFailed,
  type OperationContext,
} from "../operation-transaction.ts";
import { requireSitePermission } from "./auth.ts";
import { retryCatalogueTransaction } from "./catalogue-transaction.ts";
import { generatedId, optionalText } from "./ids.ts";

type ReviewStatement = Parameters<BoozeDatabase["batch"]>[0][number];
export type ReviewMutationResult<Resource> = {
  readonly affectedRecordCount: number;
  readonly before: Resource | null;
  readonly after: Resource | null;
};

export type ReviewSourceInput = {
  readonly siteId: string;
  readonly name: string;
  readonly sourceType?: string | undefined;
  readonly url?: string | undefined;
  readonly notes?: string | undefined;
  readonly isActive?: boolean | undefined;
};

export const criticReviewInputSchema = z.object({
  id: z.string().trim().min(1).max(120).optional(),
  reviewSourceId: z.string().trim().min(1).max(120).optional(),
  reviewSourceName: z.string().trim().min(1).max(160).optional(),
  ratingText: z.string().trim().min(1).max(160),
  ratingValue: z.number().min(0).max(1000).optional(),
  ratingScale: z.string().trim().max(80).optional(),
  sourceUrl: z.url().trim().max(500).optional().or(z.literal("")),
  reviewedAt: z.string().trim().max(80).optional(),
  provenance: z.string().trim().max(500).optional(),
  notes: z.string().trim().max(1_000).optional(),
});

export type CriticReviewInput = z.infer<typeof criticReviewInputSchema>;

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

const reviewSourceSnapshotSchema = z.object({
  id: z.string(),
  siteId: z.string().nullable(),
  siteName: z.string().nullable(),
  name: z.string(),
  sourceType: z.string(),
  url: z.string().nullable(),
  notes: z.string().nullable(),
  isActive: z.boolean(),
});

const criticReviewFactSchema = z.object({
  id: z.string(),
  siteId: z.string(),
  wineVintageId: z.string(),
  reviewSourceId: z.string(),
  reviewSourceName: z.string(),
  ratingText: z.string(),
  ratingValue: z.number().nullable(),
  ratingScale: z.string().nullable(),
  sourceUrl: z.string().nullable(),
  reviewedAt: z.string().nullable(),
  provenance: z.string().nullable(),
  notes: z.string().nullable(),
});

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
  input,
  ...context
}: OperationContext & {
  readonly input: ReviewSourceInput;
}): Promise<ReviewMutationResult<ReviewSourceResource> & { readonly after: ReviewSourceResource }> {
  const { database, userId } = context;
  await requireSitePermission({
    ...context,
    permission: "site.content.write",
    siteId: input.siteId,
  });
  return retryCatalogueTransaction(async () => {
    const existing = (await listReviewSources({ database, siteId: input.siteId, userId })).find(
      (source) => source.siteId === input.siteId && source.name === input.name.trim(),
    );
    const reviewSourceId = existing?.id ?? generatedId("review-source");
    const snapshot = reviewSourceSnapshot(reviewSourceId);
    const audit = createOperationAudit({
      context,
      siteId: input.siteId,
      action: "cellar.create_review_source",
      targetKind: "review_source",
      targetId: reviewSourceId,
      input,
      before: snapshot,
    });
    const results = await commitOperation(context, input.siteId, [
      audit.begin,
      createReviewSourceUpsert({ database, input, reviewSourceId }),
      audit.finish(snapshot),
      audit.read,
    ]);
    const result = readReviewMutation(results.at(-1), reviewSourceSnapshotSchema);
    if (result.after === null) throw new Error("Review source upsert did not return a row");
    return { ...result, after: result.after };
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
  reviews,
  siteId,
  wineVintageId,
  ...context
}: OperationContext & {
  readonly reviews: readonly CriticReviewInput[];
  readonly siteId: string;
  readonly wineVintageId: string;
}): Promise<{
  readonly affectedRecordCount: number;
  readonly before: readonly CriticReviewFact[];
  readonly after: readonly CriticReviewFact[];
}> {
  await requireSitePermission({ ...context, permission: "site.content.write", siteId });
  await assertWineVintageInSite({ ...context, siteId, wineVintageId });
  return retryCatalogueTransaction(async () => {
    const { statements, existingSourceIds } = await prepareCriticReviewChanges({
      ...context,
      reviews,
      siteId,
      wineVintageId,
    });
    const snapshot = criticReviewSetSnapshot(siteId, wineVintageId);
    const audit = createOperationAudit({
      context,
      siteId,
      action: "cellar.replace_critic_reviews",
      targetKind: "wine",
      targetId: wineVintageId,
      input: { reviews, siteId, wineVintageId },
      before: snapshot,
    });
    const beforeReviews = sql`json_extract((select before_json from mcp_tool_audit_events where id = ${audit.id}), '$.reviews')`;
    const afterReviews = sql`json_extract(${snapshot}, '$.reviews')`;
    const count = sql`(
      select count(*) from json_each(${beforeReviews}) previous
      where not exists (select 1 from json_each(${afterReviews}) current where previous.value = current.value)
    ) + (
      select count(*) from json_each(${afterReviews}) current
      where not exists (select 1 from json_each(${beforeReviews}) previous
        where json_extract(previous.value, '$.id') = json_extract(current.value, '$.id'))
    )`;

    const results = await commitReviewOperation(context, siteId, wineVintageId, existingSourceIds, [
      wineVintageGuard(context.database, siteId, wineVintageId),
      audit.begin,
      ...statements,
      audit.finish(snapshot, count),
      audit.read,
    ]);
    const result = readReviewMutation(
      results.at(-1),
      z.object({ reviews: z.array(criticReviewFactSchema) }),
    );
    if (result.before === null || result.after === null)
      throw new Error("Review replacement did not return snapshots");
    return {
      affectedRecordCount: result.affectedRecordCount,
      before: result.before.reviews,
      after: result.after.reviews,
    };
  });
}

export async function prepareCriticReviewStatements(
  input: Parameters<typeof prepareCriticReviewChanges>[0],
): Promise<ReviewStatement[]> {
  return (await prepareCriticReviewChanges(input)).statements;
}

async function prepareCriticReviewChanges({
  database,
  reviews,
  siteId,
  userId,
  wineVintageId,
  removeMissing = true,
  overwriteExisting = true,
}: {
  readonly database: BoozeDatabase;
  readonly reviews: readonly CriticReviewInput[];
  readonly siteId: string;
  readonly userId: string;
  readonly wineVintageId: string;
  readonly removeMissing?: boolean;
  readonly overwriteExisting?: boolean;
}): Promise<{
  readonly statements: ReviewStatement[];
  readonly reviewIds: readonly string[];
  readonly existingSourceIds: readonly string[];
}> {
  const statements: ReviewStatement[] = [];
  const reviewIds: string[] = [];
  const sources = [...(await listReviewSources({ database, siteId, userId }))];
  const storedSourceIds = new Set(sources.map((source) => source.id));
  const existingReviewIds = new Map(
    (await listCriticReviews({ database, userId, wineVintageId })).map((review) => [
      review.reviewSourceId,
      review.id,
    ]),
  );
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
    statements.push(reviewSourceGuard(database, siteId, source.id));
    keptReviewSourceIds.push(source.id);
    const previous = existingReviewIds.get(source.id);
    if (previous !== undefined && !overwriteExisting) continue;
    const reviewId = previous ?? generatedId("critic-review");
    existingReviewIds.set(source.id, reviewId);
    reviewIds.push(reviewId);
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
  return {
    statements,
    reviewIds,
    existingSourceIds: [...new Set(keptReviewSourceIds.filter((id) => storedSourceIds.has(id)))],
  };
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
  review,
  wineVintageId,
  ...context
}: OperationContext & {
  readonly review: CriticReviewInput;
  readonly wineVintageId: string;
}): Promise<ReviewMutationResult<CriticReviewFact> & { readonly after: CriticReviewFact }> {
  const wine = await authorisedWineVintage({ ...context, wineVintageId });
  const siteId = wine.siteId;
  await requireSitePermission({ ...context, permission: "site.content.write", siteId });
  return retryCatalogueTransaction(async () => {
    const { statements, reviewIds, existingSourceIds } = await prepareCriticReviewChanges({
      ...context,
      reviews: [review],
      siteId,
      wineVintageId,
      removeMissing: false,
    });
    const reviewId = reviewIds[0];
    if (reviewId === undefined) throw new Error("Critic review requires a write");
    const snapshot = criticReviewSnapshot(reviewId);
    const audit = createOperationAudit({
      context,
      siteId,
      action: "cellar.upsert_critic_review",
      targetKind: "critic_review",
      targetId: reviewId,
      input: { review, wineVintageId },
      before: snapshot,
    });
    const results = await commitReviewOperation(context, siteId, wineVintageId, existingSourceIds, [
      wineVintageGuard(context.database, siteId, wineVintageId),
      audit.begin,
      ...statements,
      audit.finish(snapshot),
      audit.read,
    ]);
    const result = readReviewMutation(results.at(-1), criticReviewFactSchema);
    if (result.after === null) throw new Error("Critic review upsert did not return a row");
    return { ...result, after: result.after };
  });
}

export async function deleteCriticReview({
  reviewId,
  ...context
}: OperationContext & {
  readonly reviewId: string;
}): Promise<ReviewMutationResult<CriticReviewFact> & { readonly before: CriticReviewFact }> {
  const { database, userId } = context;
  const review = (await listCriticReviews({ database, userId })).find(
    (candidate) => candidate.id === reviewId,
  );
  if (review === undefined) throw new HTTPException(404, { message: "Critic review not found" });
  const siteId = review.siteId;
  await requireSitePermission({ ...context, permission: "site.content.write", siteId });
  const snapshot = criticReviewSnapshot(reviewId);
  const audit = createOperationAudit({
    context,
    siteId,
    action: "cellar.delete_critic_review",
    targetKind: "critic_review",
    targetId: reviewId,
    input: { reviewId },
    before: snapshot,
  });
  try {
    const results = await commitOperation(context, siteId, [
      database
        .insert(criticReviews)
        .values({
          id: reviewId,
          siteId: sql`(select site_id from critic_reviews where id = ${reviewId} and site_id = ${siteId})`,
          wineVintageId: review.wineVintageId,
          reviewSourceId: review.reviewSourceId,
          ratingText: "",
        })
        .onConflictDoNothing({ target: criticReviews.id }),
      audit.begin,
      database
        .delete(criticReviews)
        .where(and(eq(criticReviews.id, reviewId), eq(criticReviews.siteId, siteId))),
      audit.finish(sql`'{}'`),
      audit.read,
    ]);
    const result = readReviewMutation(results.at(-1), criticReviewFactSchema);
    if (result.before === null) throw new Error("Critic review deletion did not return a row");
    return { ...result, before: result.before };
  } catch (error) {
    if (operationConstraintFailed(error, "NOT NULL constraint failed: critic_reviews.site_id")) {
      const existing = await listCriticReviews({ database, userId });
      if (!existing.some((candidate) => candidate.id === reviewId && candidate.siteId === siteId)) {
        throw new HTTPException(404, { message: "Critic review not found" });
      }
    }
    throw error;
  }
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

function readReviewMutation<Snapshot>(
  rows: unknown,
  schema: z.ZodType<Snapshot>,
): ReviewMutationResult<Snapshot> {
  const audit = z.array(operationAuditResultSchema).min(1).parse(rows)[0];
  if (audit === undefined) throw new Error("Review mutation did not return its audit event");
  const snapshot = schema.or(z.strictObject({}).transform(() => null));
  return {
    affectedRecordCount: audit.affectedRecordCount,
    before: snapshot.parse(JSON.parse(audit.beforeJson)),
    after: snapshot.parse(JSON.parse(audit.afterJson)),
  };
}

function reviewSourceSnapshot(reviewSourceId: string): SQL {
  return sql`(select json_object(
    'id', source.id, 'siteId', source.site_id, 'siteName', site.name,
    'name', source.name, 'sourceType', source.source_type, 'url', source.url,
    'notes', source.notes, 'isActive', json(case when source.is_active then 'true' else 'false' end)
  ) from review_sources source left join sites site on source.site_id = site.id where source.id = ${reviewSourceId})`;
}

function criticReviewJson(): SQL {
  return sql`json_object(
    'id', review.id, 'siteId', review.site_id, 'wineVintageId', review.wine_vintage_id,
    'reviewSourceId', review.review_source_id, 'reviewSourceName', source.name,
    'ratingText', review.rating_text, 'ratingValue', review.rating_value,
    'ratingScale', review.rating_scale, 'sourceUrl', review.source_url,
    'reviewedAt', review.reviewed_at, 'provenance', review.provenance, 'notes', review.notes
  )`;
}

function criticReviewSnapshot(reviewId: string): SQL {
  return sql`(select ${criticReviewJson()} from critic_reviews review
    join review_sources source on source.id = review.review_source_id where review.id = ${reviewId})`;
}

function criticReviewSetSnapshot(siteId: string, wineVintageId: string): SQL {
  return sql`(select json_object('reviews', json(coalesce(json_group_array(json(fact)), '[]'))) from (
    select ${criticReviewJson()} as fact from critic_reviews review
    join review_sources source on source.id = review.review_source_id
    where review.site_id = ${siteId} and review.wine_vintage_id = ${wineVintageId}
    order by review.id
  ))`;
}

function reviewSourceGuard(
  database: BoozeDatabase,
  siteId: string,
  reviewSourceId: string,
): ReviewStatement {
  // NOT NULL is checked before the targeted ID conflict. Existing source rows
  // stay untouched; a stale source scope or activation state aborts the batch.
  return database
    .insert(reviewSources)
    .values({
      id: reviewSourceId,
      name: sql`(select name from review_sources where id = ${reviewSourceId}
      and (site_id is null or site_id = ${siteId}) and is_active = 1)`,
    })
    .onConflictDoNothing({ target: reviewSources.id });
}

function wineVintageGuard(
  database: BoozeDatabase,
  siteId: string,
  wineVintageId: string,
): ReviewStatement {
  return database
    .insert(wineVintages)
    .values({
      id: wineVintageId,
      siteId: sql`(select site_id from wine_vintages where id = ${wineVintageId} and site_id = ${siteId})`,
      baseName: "",
      displayName: "",
      vintageLabel: "",
    })
    .onConflictDoNothing({ target: wineVintages.id });
}

async function commitReviewOperation<T extends readonly [ReviewStatement, ...ReviewStatement[]]>(
  context: OperationContext,
  siteId: string,
  wineVintageId: string,
  existingSourceIds: readonly string[],
  statements: T,
) {
  try {
    return await commitOperation(context, siteId, statements);
  } catch (error) {
    if (operationConstraintFailed(error, "NOT NULL constraint failed: wine_vintages.site_id")) {
      await assertWineVintageInSite({ ...context, siteId, wineVintageId });
    }
    if (operationConstraintFailed(error, "NOT NULL constraint failed: review_sources.name")) {
      const sources = await listReviewSources({ ...context, siteId });
      if (
        existingSourceIds.some(
          (id) => !sources.some((source) => source.id === id && source.isActive),
        )
      ) {
        throw new HTTPException(400, { message: "Review source is not available for this site" });
      }
    }
    throw error;
  }
}
