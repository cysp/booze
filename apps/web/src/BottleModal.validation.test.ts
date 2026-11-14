import { describe, expect, it } from "vitest";

import { validateAwards, validateCriticReviews, type AwardDraft } from "./bottle-metadata.ts";
import type { CriticReviewInput } from "./inventory-model.ts";

describe("repeatable bottle metadata validation", () => {
  it("blocks incomplete reviews instead of silently dropping them", () => {
    const reviews = [{ ratingText: "", reviewSourceName: "  " }] satisfies CriticReviewInput[];

    const result = validateCriticReviews(reviews);

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      { ratingText: "Rating is required.", reviewSourceName: "Source is required." },
    ]);
  });

  it("normalises complete reviews without losing the row", () => {
    const reviews = [
      { ratingText: " 95 points ", reviewSourceName: " Halliday " },
    ] satisfies CriticReviewInput[];

    const result = validateCriticReviews(reviews);

    expect(result).toEqual({
      errors: [{}],
      ok: true,
      values: [{ ratingText: "95 points", reviewSourceName: "Halliday" }],
    });
  });

  it("reports required and numeric award errors without coercing values", () => {
    const awards = [
      { awardLevel: "", awardName: "", awardYear: "twenty", points: "high" },
    ] satisfies AwardDraft[];

    const result = validateAwards(awards);

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      {
        awardLevel: "Award is required.",
        awardName: "Competition or source is required.",
        awardYear: "Year must be a whole number.",
        points: "Points must be a decimal number.",
      },
    ]);
  });

  it.each([" ", "0x10", "1e2", "Infinity", "NaN", "95 points"])(
    "rejects non-decimal points %j",
    (points) => {
      const awards = [
        { awardLevel: "Gold", awardName: "Wine Show", awardYear: "2025", points },
      ] satisfies AwardDraft[];

      const result = validateAwards(awards);

      expect(result.ok).toBe(false);
      expect(result.errors).toEqual([{ points: "Points must be a decimal number." }]);
    },
  );

  it.each([
    ["0", 0],
    [" 95.5 ", 95.5],
    ["+12", 12],
    ["-.5", -0.5],
  ])("normalises decimal points %j", (points, expected) => {
    const awards = [
      { awardLevel: "Gold", awardName: "Wine Show", awardYear: " 2025 ", points },
    ] satisfies AwardDraft[];

    const result = validateAwards(awards);

    expect(result).toEqual({
      errors: [{}],
      ok: true,
      values: [
        {
          awardLevel: "Gold",
          awardName: "Wine Show",
          awardYear: 2025,
          points: expected,
        },
      ],
    });
  });
});
