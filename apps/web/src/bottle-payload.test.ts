import { describe, expect, it } from "vitest";
import {
  bottleCreatePayload,
  bottleEditPayload,
  bottleFormSubmission,
  type BottleActionKind,
  type BottleAddSubmit,
} from "./bottle-payload.ts";
import {
  formStateForItem,
  initialFormState,
  type FormState,
  type InventoryItem,
} from "./inventory-model.ts";
import { inventoryItemFixture } from "./test/catalogue-fixtures.ts";

function edit(
  kind: BottleActionKind,
  item: InventoryItem,
  form = formStateForItem(item),
  evidence = {},
) {
  const submission = bottleFormSubmission({ kind, item }, form, evidence, "");
  if (submission.kind === "add") throw new Error("Expected existing bottle action");
  return JSON.parse(JSON.stringify(bottleEditPayload(submission, item))) as unknown;
}
const sharedGuard = {
  wineEditScope: "shared",
  expectedWineVintageId: "vintage-1",
  expectedAffectedBottleCount: 1,
};

describe("focused bottle action payloads", () => {
  it("moves only storage, preserving the position note", () => {
    const item = inventoryItemFixture({ positionHint: "Row 2" });
    const form = {
      ...formStateForItem(item),
      storageLocationId: "location-top",
      wineryName: "Ignored",
      bottleNotes: "Ignored",
    };
    expect(edit("move", item, form)).toEqual({
      storageLocationId: "location-top",
      positionHint: "Row 2",
    });
  });
  it("leaves unchanged stored facts untouched", () => {
    const item = inventoryItemFixture({ baseName: "Shiraz", designation: "Reserve" });
    expect(edit("edit-bottle", item)).toEqual({});
    expect(edit("correct-wine", item)).toEqual({});
  });
  it("limits bottle editing to physical facts and never resubmits historical wine or volume", () => {
    const item = inventoryItemFixture({ volumeMl: 75_000, alcoholPercent: 140, vintageYear: 1700 });
    const form = { ...formStateForItem(item), wineryName: "Ignored", bottleNotes: "Damaged label" };
    expect(edit("edit-bottle", item, form)).toEqual({ bottle: { notes: "Damaged label" } });
    expect(item.volumeMl).toBe(75_000);
  });
  it("exposes the stored bottle number as a bottle fact", () => {
    const item = inventoryItemFixture();
    expect(
      edit("edit-bottle", item, { ...formStateForItem(item), bottleNumber: "Case A / 2" }),
    ).toEqual({ bottle: { bottleNumber: "Case A / 2" } });
  });
  it("corrects shared designation with both concurrency guards and no bottle changes", () => {
    const item = inventoryItemFixture();
    expect(
      edit("correct-wine", item, {
        ...formStateForItem(item),
        designation: "Reserve",
        bottleNotes: "Ignored",
      }),
    ).toEqual({ ...sharedGuard, wine: { designation: "Reserve" } });
  });
  it("compares raw wine drafts before parsing historical facts", () => {
    const item = inventoryItemFixture({
      alcoholPercent: 140,
      vintageYear: 1700,
      drinkFromYear: 1650,
      drinkToYear: 1750,
      grapeVarieties: ["  Historic grape  "],
    });
    expect(edit("correct-wine", item, { ...formStateForItem(item), wineNotes: "Checked" })).toEqual(
      { ...sharedGuard, wine: { notes: "Checked" } },
    );
  });
  it("clears nullable facts and keeps unknown distinct from explicit NV", () => {
    const item = inventoryItemFixture();
    expect(
      edit("correct-wine", item, {
        ...formStateForItem(item),
        alcoholPercent: "",
        vintageStatus: "unknown",
        vintageYear: "",
        drinkFromYear: "",
        drinkToYear: "",
      }),
    ).toEqual({
      ...sharedGuard,
      wine: {
        alcoholPercent: null,
        vintageStatus: "unknown",
        vintageYear: null,
        drinkFromYear: null,
        drinkToYear: null,
      },
    });
  });
  it("submits the complete drinking window when either endpoint changes", () => {
    const item = inventoryItemFixture();
    expect(
      edit("correct-wine", item, { ...formStateForItem(item), drinkFromYear: "2028" }),
    ).toEqual({ ...sharedGuard, wine: { drinkFromYear: 2028, drinkToYear: item.drinkToYear } });
  });
  it("reassigns only this bottle without sending changes or evidence to the selected wine", () => {
    const item = inventoryItemFixture();
    const submission = bottleFormSubmission(
      { kind: "reassign", item },
      formStateForItem(item),
      { criticReviews: [{ ratingText: "91", reviewSourceName: "Ignored" }] },
      "target-wine",
    );
    if (submission.kind === "add") throw new Error("Unexpected addition");
    expect(bottleEditPayload(submission, item)).toEqual({
      wineEditScope: "bottle",
      expectedWineVintageId: item.wineVintageId,
      wineVintageId: "target-wine",
    });
  });
  it("creates an explicitly blank new wine and never copies original evidence IDs", () => {
    const item = inventoryItemFixture();
    const payload = edit("reassign", item, initialFormState, {
      criticReviews: [
        { id: "old-review", reviewSourceName: "Original", ratingText: "95" },
        { reviewSourceName: "New", ratingText: "91" },
      ],
      awards: [
        { id: "old-award", awardName: "Original", awardLevel: "Gold" },
        { awardName: "New", awardLevel: "Silver" },
      ],
    });
    expect(payload).toMatchObject({
      wineEditScope: "bottle",
      expectedWineVintageId: item.wineVintageId,
      wine: {
        wineryName: "",
        grapeVarieties: [],
        alcoholPercent: null,
        drinkFromYear: null,
        drinkToYear: null,
        vintageYear: null,
      },
      criticReviews: [{ reviewSourceName: "New", ratingText: "91" }],
      awards: [{ awardName: "New", awardLevel: "Silver" }],
    });
    expect(payload).not.toHaveProperty("wineVintageId");
  });
});

function addition(form: FormState): BottleAddSubmit {
  return { kind: "add", form, awards: [], criticReviews: [] };
}

describe("bottle addition payloads", () => {
  it("preserves identity and grapes without inventing a designation", () => {
    const payload = bottleCreatePayload(
      addition({
        ...initialFormState,
        wineryName: "RIKARD",
        grapeVarieties: ["Shiraz"],
        vintageStatus: "year",
        vintageYear: "2022",
      }),
    );
    expect(payload.wine).toMatchObject({
      wineryName: "RIKARD",
      designation: "",
      vintageYear: 2022,
      vintageStatus: "year",
    });
    expect(payload.wine).not.toHaveProperty("displayName");
    expect(payload.wine).not.toHaveProperty("baseName");
  });
  it("keeps explicit NV separate from unknown", () => {
    expect(bottleCreatePayload(addition(initialFormState)).wine).toMatchObject({
      vintageStatus: "unknown",
      vintageYear: null,
    });
    expect(
      bottleCreatePayload(
        addition({ ...initialFormState, vintageStatus: "non_vintage", vintageYear: "2022" }),
      ).wine,
    ).toMatchObject({ vintageStatus: "non_vintage", vintageYear: null });
  });
  it("uses an existing wine without overwriting its facts or evidence", () => {
    const payload = bottleCreatePayload({
      ...addition(formStateForItem(inventoryItemFixture())),
      wineVintageId: "target-wine",
    });
    expect(payload.wineVintageId).toBe("target-wine");
    expect(payload).not.toHaveProperty("wine");
    expect(payload).not.toHaveProperty("criticReviews");
    expect(payload).not.toHaveProperty("awards");
  });
});
