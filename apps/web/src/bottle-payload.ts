import {
  awardInputsForItem,
  criticReviewInputsForItem,
  validateAwards,
  validateCriticReviews,
} from "./bottle-metadata.ts";
import type { BottleModalSubmit } from "./BottleModal.tsx";
import {
  formStateForItem,
  parseOptionalDecimal,
  parseOptionalVolumeMl,
  parseOptionalYear,
  type BottlePatch,
  type InventoryItem,
} from "./inventory-model.ts";

function formPayload({ awards, criticReviews, form }: BottleModalSubmit) {
  return {
    storageLocationId: form.storageLocationId === "" ? null : form.storageLocationId,
    positionHint: form.position,
    wine: {
      wineryName: form.wineryName,
      brandName: form.brandName,
      designation: form.designation,
      vintageStatus: form.vintageStatus,
      vintageYear: form.vintageStatus === "year" ? parseOptionalYear(form.vintageYear) : null,
      grapeVarieties: form.grapeVarieties
        .map((value) => value.trim())
        .filter((value) => value !== ""),
      country: form.country,
      region: form.region,
      appellation: form.appellation,
      classification: form.classification,
      wineType: form.wineType,
      wineColor: form.wineColor,
      addressQualification: form.addressQualification,
      alcoholPercent: parseOptionalDecimal(form.alcoholPercent),
      drinkFromYear: parseOptionalYear(form.drinkFromYear),
      drinkToYear: parseOptionalYear(form.drinkToYear),
      description: form.description,
      drinkingAdvice: form.drinkingAdvice,
      labelText: form.labelText,
      sourceUrl: form.sourceUrl,
      notes: form.wineNotes,
    },
    bottle: {
      volumeMl: parseOptionalVolumeMl(form.bottleVolumeMl),
      barcode: form.barcode,
      lotCode: form.lotCode,
      notes: form.bottleNotes,
    },
    labelExtraction:
      form.labelExtractionJson.trim() === ""
        ? undefined
        : { extractedFieldsJson: form.labelExtractionJson },
    criticReviews,
    awards,
  };
}

export function bottleCreatePayload(submission: BottleModalSubmit): BottlePatch {
  const payload = formPayload(submission);
  if (submission.wineVintageId !== undefined && submission.wineVintageId !== "") {
    return {
      storageLocationId: payload.storageLocationId,
      positionHint: payload.positionHint,
      bottle: payload.bottle,
      wineVintageId: submission.wineVintageId,
    };
  }
  return { ...payload, allowUnidentified: submission.allowUnidentified };
}

export function bottleEditPayload(submission: BottleModalSubmit, item: InventoryItem): BottlePatch {
  const originalReviews = validateCriticReviews(criticReviewInputsForItem(item));
  const originalAwards = validateAwards(awardInputsForItem(item));
  const original = editablePayload({
    awards: originalAwards.ok ? originalAwards.values : [],
    criticReviews: originalReviews.ok ? originalReviews.values : [],
    form: formStateForItem(item),
  });
  const current = editablePayload(submission);
  const changed = changedFields(current, original);
  const bottle = changedFields(current.bottle, original.bottle);
  const bottleChanges: BottlePatch = {
    ...(current.storageLocationId === original.storageLocationId
      ? {}
      : { storageLocationId: current.storageLocationId, positionHint: current.positionHint }),
    ...(current.positionHint === original.positionHint
      ? {}
      : { positionHint: current.positionHint }),
    ...(Object.keys(bottle).length === 0 ? {} : { bottle }),
  };
  if (submission.wineEditScope === undefined) {
    return bottleChanges;
  }
  const guard = {
    wineEditScope: submission.wineEditScope,
    expectedWineVintageId: item.wineVintageId,
  };
  if (
    submission.wineEditScope === "bottle" &&
    submission.wineVintageId !== undefined &&
    submission.wineVintageId !== ""
  ) {
    return { ...bottleChanges, ...guard, wineVintageId: submission.wineVintageId };
  }
  if (submission.wineEditScope === "bottle") {
    return {
      ...bottleChanges,
      ...guard,
      wine: current.wine,
      allowUnidentified: submission.allowUnidentified,
      ...newWineEvidence(current.criticReviews, current.awards),
    };
  }
  const wine = changedWineFacts(current.wine, original.wine);
  if (
    Object.keys(wine).length === 0 &&
    changed.criticReviews === undefined &&
    changed.awards === undefined
  ) {
    return bottleChanges;
  }
  return {
    ...bottleChanges,
    ...guard,
    expectedAffectedBottleCount: item.wineBottleCount,
    allowUnidentified: submission.allowUnidentified,
    ...(Object.keys(wine).length === 0 ? {} : { wine }),
    ...(changed.criticReviews === undefined ? {} : { criticReviews: changed.criticReviews }),
    ...(changed.awards === undefined ? {} : { awards: changed.awards }),
  };
}

function newWineEvidence(
  reviews: NonNullable<BottlePatch["criticReviews"]>,
  awards: NonNullable<BottlePatch["awards"]>,
): BottlePatch {
  const newReviews = reviews.filter((review) => review.id === undefined);
  const newAwards = awards.filter((award) => award.id === undefined);
  return {
    ...(newReviews.length === 0 ? {} : { criticReviews: newReviews }),
    ...(newAwards.length === 0 ? {} : { awards: newAwards }),
  };
}

function changedWineFacts(
  current: ReturnType<typeof editablePayload>["wine"],
  original: ReturnType<typeof editablePayload>["wine"],
) {
  return {
    ...changedFields(current, original),
    ...(current.vintageYear !== original.vintageYear ||
    current.vintageStatus !== original.vintageStatus
      ? { vintageYear: current.vintageYear, vintageStatus: current.vintageStatus }
      : {}),
    ...(current.drinkFromYear !== original.drinkFromYear ||
    current.drinkToYear !== original.drinkToYear
      ? { drinkFromYear: current.drinkFromYear, drinkToYear: current.drinkToYear }
      : {}),
  };
}

function editablePayload(submission: BottleModalSubmit) {
  const payload = formPayload(submission);
  return {
    ...payload,
    wine: {
      ...payload.wine,
      vintageYear: payload.wine.vintageYear ?? null,
      alcoholPercent: payload.wine.alcoholPercent ?? null,
      drinkFromYear: payload.wine.drinkFromYear ?? null,
      drinkToYear: payload.wine.drinkToYear ?? null,
    },
  };
}

function changedFields<T extends object>(current: T, original: T): Partial<T> {
  const changed: Partial<T> = {};
  for (const key in current) {
    if (
      Object.hasOwn(current, key) &&
      JSON.stringify(current[key]) !== JSON.stringify(original[key])
    ) {
      changed[key] = current[key];
    }
  }
  return changed;
}
