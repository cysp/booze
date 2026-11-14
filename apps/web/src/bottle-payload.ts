import type { BottleInput, WineInput, WinePatchInput } from "../shared/catalogue-inputs.ts";
import {
  formStateForItem,
  parseOptionalDecimal,
  parseOptionalVolumeMl,
  parseOptionalYear,
  type BottlePatch,
  type CriticReviewInput,
  type FormState,
  type InventoryItem,
  type WineAwardInput,
} from "./inventory-model.ts";

export type BottleActionKind = "move" | "edit-bottle" | "correct-wine" | "reassign";
export type BottleFormAction =
  | { readonly kind: "add"; readonly form: FormState }
  | { readonly kind: BottleActionKind; readonly item: InventoryItem };

type WineEvidence = {
  readonly criticReviews?: readonly CriticReviewInput[] | undefined;
  readonly awards?: readonly WineAwardInput[] | undefined;
  readonly allowUnidentified?: boolean | undefined;
};

export type BottleAddSubmit = WineEvidence & {
  readonly kind: "add";
  readonly form: FormState;
  readonly wineVintageId?: string | undefined;
};
export type BottleEditSubmit =
  | {
      readonly kind: "move";
      readonly storageLocationId: string | null;
      readonly positionHint: string;
    }
  | { readonly kind: "edit-bottle"; readonly bottle: BottleInput }
  | (WineEvidence & { readonly kind: "correct-wine"; readonly wine?: WinePatchInput | undefined })
  | { readonly kind: "reassign"; readonly wineVintageId: string }
  | (WineEvidence & { readonly kind: "reassign"; readonly wine: WineInput });
export type BottleModalSubmit = BottleAddSubmit | BottleEditSubmit;
export type BottleModalSubmitResult =
  | { readonly ok: true }
  | { readonly message: string; readonly ok: false };

export function bottleCreatePayload(submission: BottleAddSubmit): BottlePatch {
  const { form } = submission;
  const bottle = newBottleFacts(form);
  const storage = {
    storageLocationId: form.storageLocationId === "" ? null : form.storageLocationId,
    positionHint: form.position,
  };
  if (submission.wineVintageId !== undefined && submission.wineVintageId !== "") {
    return { ...storage, bottle, wineVintageId: submission.wineVintageId };
  }
  return {
    ...storage,
    bottle,
    wine: newWineFacts(form),
    allowUnidentified: submission.allowUnidentified,
    criticReviews: submission.criticReviews,
    awards: submission.awards,
    ...(form.labelExtractionJson.trim() === ""
      ? {}
      : { labelExtraction: { extractedFieldsJson: form.labelExtractionJson } }),
  };
}

export function bottleEditPayload(submission: BottleEditSubmit, item: InventoryItem): BottlePatch {
  switch (submission.kind) {
    case "move":
      return {
        ...(submission.storageLocationId === item.storageLocationId
          ? {}
          : {
              storageLocationId: submission.storageLocationId,
              positionHint: submission.positionHint,
            }),
        ...(submission.positionHint === (item.positionHint ?? "")
          ? {}
          : { positionHint: submission.positionHint }),
      };
    case "edit-bottle":
      return Object.keys(submission.bottle).length === 0 ? {} : { bottle: submission.bottle };
    case "correct-wine":
      if (
        (submission.wine === undefined || Object.keys(submission.wine).length === 0) &&
        submission.criticReviews === undefined &&
        submission.awards === undefined
      )
        return {};
      return {
        wineEditScope: "shared",
        expectedWineVintageId: item.wineVintageId,
        expectedAffectedBottleCount: item.wineBottleCount,
        wine: submission.wine,
        allowUnidentified: submission.allowUnidentified,
        criticReviews: submission.criticReviews,
        awards: submission.awards,
      };
    case "reassign":
      return {
        wineEditScope: "bottle",
        expectedWineVintageId: item.wineVintageId,
        ...("wineVintageId" in submission
          ? { wineVintageId: submission.wineVintageId }
          : {
              wine: submission.wine,
              allowUnidentified: submission.allowUnidentified,
              ...newWineEvidence(submission),
            }),
      };
    default: {
      const exhaustive: never = submission;
      return exhaustive;
    }
  }
}

export function bottleFormSubmission(
  action: BottleFormAction,
  draft: FormState,
  evidence: WineEvidence,
  wineVintageId: string,
): BottleModalSubmit {
  if (action.kind === "add")
    return { kind: "add", form: draft, ...evidence, wineVintageId: wineVintageId || undefined };
  switch (action.kind) {
    case "move":
      return {
        kind: "move",
        storageLocationId: draft.storageLocationId || null,
        positionHint: draft.position,
      };
    case "edit-bottle":
      return {
        kind: "edit-bottle",
        bottle: changedBottleFacts(draft, formStateForItem(action.item)),
      };
    case "correct-wine":
      return {
        kind: "correct-wine",
        wine: changedWineFacts(draft, formStateForItem(action.item)),
        ...evidence,
      };
    case "reassign":
      return wineVintageId === ""
        ? { kind: "reassign", wine: newWineFacts(draft), ...evidence }
        : { kind: "reassign", wineVintageId };
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

function newBottleFacts(form: FormState): BottleInput {
  return {
    bottleNumber: form.bottleNumber,
    volumeMl: parseOptionalVolumeMl(form.bottleVolumeMl),
    barcode: form.barcode,
    lotCode: form.lotCode,
    notes: form.bottleNotes,
  };
}

const wineTextFields = [
  "wineryName",
  "brandName",
  "designation",
  "country",
  "region",
  "appellation",
  "classification",
  "wineType",
  "wineColor",
  "addressQualification",
  "description",
  "drinkingAdvice",
  "labelText",
  "sourceUrl",
] as const;

function newWineFacts(form: FormState): WineInput {
  return {
    ...Object.fromEntries(wineTextFields.map((name) => [name, form[name]])),
    wineryName: form.wineryName,
    vintageStatus: form.vintageStatus,
    vintageYear: form.vintageStatus === "year" ? parseOptionalYear(form.vintageYear) : null,
    grapeVarieties: form.grapeVarieties
      .map((value) => value.trim())
      .filter((value) => value !== ""),
    alcoholPercent: parseOptionalDecimal(form.alcoholPercent) ?? null,
    drinkFromYear: parseOptionalYear(form.drinkFromYear) ?? null,
    drinkToYear: parseOptionalYear(form.drinkToYear) ?? null,
    notes: form.wineNotes,
  };
}

// Compare raw drafts first: unchanged stored values never pass through new-entry parsing.
function changedBottleFacts(current: FormState, original: FormState): BottleInput {
  return {
    ...(current.bottleNumber === original.bottleNumber
      ? {}
      : { bottleNumber: current.bottleNumber }),
    ...(current.bottleVolumeMl === original.bottleVolumeMl
      ? {}
      : { volumeMl: parseOptionalVolumeMl(current.bottleVolumeMl) }),
    ...(current.barcode === original.barcode ? {} : { barcode: current.barcode }),
    ...(current.lotCode === original.lotCode ? {} : { lotCode: current.lotCode }),
    ...(current.bottleNotes === original.bottleNotes ? {} : { notes: current.bottleNotes }),
  };
}

function changedWineFacts(current: FormState, original: FormState): WinePatchInput {
  return {
    ...Object.fromEntries(
      wineTextFields
        .filter((name) => current[name] !== original[name])
        .map((name) => [name, current[name]]),
    ),
    ...(JSON.stringify(current.grapeVarieties) === JSON.stringify(original.grapeVarieties)
      ? {}
      : {
          grapeVarieties: current.grapeVarieties
            .map((value) => value.trim())
            .filter((value) => value !== ""),
        }),
    ...(current.wineNotes === original.wineNotes ? {} : { notes: current.wineNotes }),
    ...(current.alcoholPercent === original.alcoholPercent
      ? {}
      : { alcoholPercent: parseOptionalDecimal(current.alcoholPercent) ?? null }),
    ...(current.vintageStatus === original.vintageStatus &&
    current.vintageYear === original.vintageYear
      ? {}
      : {
          vintageStatus: current.vintageStatus,
          vintageYear:
            current.vintageStatus === "year"
              ? (parseOptionalYear(current.vintageYear) ?? null)
              : null,
        }),
    ...(current.drinkFromYear === original.drinkFromYear &&
    current.drinkToYear === original.drinkToYear
      ? {}
      : {
          drinkFromYear: parseOptionalYear(current.drinkFromYear) ?? null,
          drinkToYear: parseOptionalYear(current.drinkToYear) ?? null,
        }),
  };
}

function newWineEvidence(evidence: WineEvidence): WineEvidence {
  const criticReviews = evidence.criticReviews?.filter((review) => review.id === undefined);
  const awards = evidence.awards?.filter((award) => award.id === undefined);
  return {
    ...(criticReviews?.length === 0 ? {} : { criticReviews }),
    ...(awards?.length === 0 ? {} : { awards }),
  };
}
