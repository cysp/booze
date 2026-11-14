import type {
  CriticReviewInput,
  CriticReviewResource,
  InventoryItem,
  WineAwardInput,
  WineAwardResource,
} from "./inventory-model.ts";

export type AwardDraft = Omit<WineAwardInput, "awardYear" | "points"> & {
  readonly awardYear: string;
  readonly points: string;
};

export type ReviewErrors = {
  readonly ratingText?: string;
  readonly reviewSourceName?: string;
};

export type AwardErrors = {
  readonly awardLevel?: string;
  readonly awardName?: string;
  readonly awardYear?: string;
  readonly points?: string;
};

export type ValidationResult<T> =
  | { readonly ok: true; readonly errors: readonly Record<string, string>[]; readonly values: T }
  | { readonly ok: false; readonly errors: readonly Record<string, string>[] };

const INTEGER_PATTERN = /^[+-]?\d+$/u;
const DECIMAL_PATTERN = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/u;

export function criticReviewInputsForItem(
  item: InventoryItem | undefined,
): readonly CriticReviewInput[] {
  return (item?.criticReviews ?? []).map((review) => criticReviewInputForResource(review));
}

export function awardInputsForItem(item: InventoryItem | undefined): readonly AwardDraft[] {
  return (item?.awards ?? []).map((award) => awardInputForResource(award));
}

export function validateCriticReviews(reviews: readonly CriticReviewInput[]):
  | {
      readonly ok: true;
      readonly errors: readonly ReviewErrors[];
      readonly values: readonly CriticReviewInput[];
    }
  | { readonly ok: false; readonly errors: readonly ReviewErrors[] } {
  const values = reviews.map((review) => ({
    ...review,
    notes: review.notes?.trim(),
    provenance: review.provenance?.trim(),
    ratingText: review.ratingText.trim(),
    reviewSourceName: review.reviewSourceName?.trim(),
    sourceUrl: review.sourceUrl?.trim(),
  }));
  const errors = values.map((review) => ({
    ...(review.ratingText === "" ? { ratingText: "Rating is required." } : {}),
    ...(review.reviewSourceId === undefined &&
    (review.reviewSourceName === undefined || review.reviewSourceName === "")
      ? { reviewSourceName: "Source is required." }
      : {}),
  }));
  return errors.some((error) => Object.keys(error).length > 0)
    ? { ok: false, errors }
    : { ok: true, errors, values };
}

export function validateAwards(awards: readonly AwardDraft[]):
  | {
      readonly ok: true;
      readonly errors: readonly AwardErrors[];
      readonly values: readonly WineAwardInput[];
    }
  | { readonly ok: false; readonly errors: readonly AwardErrors[] } {
  const normalised = awards.map((award) => {
    const awardYear = award.awardYear.trim();
    const points = award.points.trim();
    return {
      value: {
        ...award,
        awardBody: award.awardBody?.trim(),
        awardLevel: award.awardLevel.trim(),
        awardName: award.awardName.trim(),
        awardYear,
        category: award.category?.trim(),
        notes: award.notes?.trim(),
        points,
        provenance: award.provenance?.trim(),
        sourceUrl: award.sourceUrl?.trim(),
      },
      whitespaceOnlyAwardYear: award.awardYear !== "" && awardYear === "",
      whitespaceOnlyPoints: award.points !== "" && points === "",
    };
  });
  const errors = normalised.map(
    ({ value: award, whitespaceOnlyAwardYear, whitespaceOnlyPoints }) => ({
      ...(award.awardLevel === "" ? { awardLevel: "Award is required." } : {}),
      ...(award.awardName === "" ? { awardName: "Competition or source is required." } : {}),
      ...(!whitespaceOnlyAwardYear && isOptionalInteger(award.awardYear)
        ? {}
        : { awardYear: "Year must be a whole number." }),
      ...(!whitespaceOnlyPoints && isOptionalDecimal(award.points)
        ? {}
        : { points: "Points must be a decimal number." }),
    }),
  );
  if (errors.some((error) => Object.keys(error).length > 0)) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    errors,
    values: normalised.map(({ value: { awardYear, points, ...award } }) => ({
      ...award,
      awardYear: awardYear === "" ? undefined : Number(awardYear),
      points: points === "" ? undefined : Number(points),
    })),
  };
}

function criticReviewInputForResource(review: CriticReviewResource): CriticReviewInput {
  return {
    id: review.id,
    notes: review.notes ?? undefined,
    provenance: review.provenance ?? undefined,
    ratingScale: review.ratingScale ?? undefined,
    ratingText: review.ratingText,
    ratingValue: review.ratingValue ?? undefined,
    reviewedAt: review.reviewedAt ?? undefined,
    reviewSourceId: review.reviewSourceId,
    reviewSourceName: review.reviewSourceName,
    sourceUrl: review.sourceUrl ?? undefined,
  };
}

function awardInputForResource(award: WineAwardResource): AwardDraft {
  return {
    awardBody: award.awardBody ?? undefined,
    awardLevel: award.awardLevel,
    awardName: award.awardName,
    awardYear: award.awardYear?.toString() ?? "",
    category: award.category ?? undefined,
    id: award.id,
    notes: award.notes ?? undefined,
    points: award.points?.toString() ?? "",
    provenance: award.provenance ?? undefined,
    sourceUrl: award.sourceUrl ?? undefined,
  };
}

function isOptionalInteger(value: string): boolean {
  return value === "" || INTEGER_PATTERN.test(value);
}

function isOptionalDecimal(value: string): boolean {
  return value === "" || DECIMAL_PATTERN.test(value);
}
