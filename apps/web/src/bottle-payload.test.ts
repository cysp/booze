import { describe, expect, it } from "vitest";

import { bottleCreatePayload, bottleEditPayload } from "./bottle-payload.ts";
import type { BottleModalSubmit } from "./BottleModal.tsx";
import { formStateForItem, initialFormState, type InventoryItem } from "./inventory-model.ts";
import { inventoryItemFixture } from "./test/catalogue-fixtures.ts";

function submissionFor(item: InventoryItem): BottleModalSubmit {
  return { awards: [], criticReviews: [], form: formStateForItem(item) };
}

function serialized(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

const sharedGuard = {
  wineEditScope: "shared",
  expectedWineVintageId: "vintage-1",
  expectedAffectedBottleCount: 1,
};

describe("bottle edit payload", () => {
  it("preserves the position note when moving to another location", () => {
    const item = inventoryItemFixture({ positionHint: "Row 2" });
    const submission = submissionFor(item);
    submission.form.storageLocationId = "location-top";
    expect(serialized(bottleEditPayload(submission, item))).toEqual({
      storageLocationId: "location-top",
      positionHint: "Row 2",
    });
  });

  it("leaves stored facts untouched when saved unchanged", () => {
    const item = inventoryItemFixture({ baseName: "Shiraz", designation: "Reserve" });
    expect(serialized(bottleEditPayload(submissionFor(item), item))).toEqual({});
  });

  it("does not submit shared facts without an explicit scope", () => {
    const item = inventoryItemFixture();
    const submission = submissionFor(item);
    submission.form.wineryName = "A different producer";
    submission.form.bottleNotes = "Damaged label";
    expect(serialized(bottleEditPayload(submission, item))).toEqual({
      bottle: { notes: "Damaged label" },
    });
  });

  it("corrects the designation without copying it into a display name", () => {
    const item = inventoryItemFixture();
    const submission = submissionFor(item);
    submission.form.designation = "Reserve";
    expect(serialized(bottleEditPayload({ ...submission, wineEditScope: "shared" }, item))).toEqual(
      {
        ...sharedGuard,
        wine: { designation: "Reserve" },
      },
    );
  });

  it("clears nullable facts and keeps unknown distinct from explicit NV", () => {
    const item = inventoryItemFixture();
    const submission = submissionFor(item);
    submission.form.addressQualification = "Bottled in Orange, NSW";
    submission.form.alcoholPercent = "";
    submission.form.vintageStatus = "unknown";
    submission.form.vintageYear = "";
    submission.form.drinkFromYear = "";
    submission.form.drinkToYear = "";
    expect(serialized(bottleEditPayload({ ...submission, wineEditScope: "shared" }, item))).toEqual(
      {
        ...sharedGuard,
        wine: {
          addressQualification: "Bottled in Orange, NSW",
          alcoholPercent: null,
          vintageStatus: "unknown",
          vintageYear: null,
          drinkFromYear: null,
          drinkToYear: null,
        },
      },
    );
  });

  it("submits the complete drinking window when either endpoint changes", () => {
    const item = inventoryItemFixture();
    const submission = submissionFor(item);
    submission.form.drinkFromYear = "2028";
    expect(serialized(bottleEditPayload({ ...submission, wineEditScope: "shared" }, item))).toEqual(
      {
        ...sharedGuard,
        wine: { drinkFromYear: 2028, drinkToYear: item.drinkToYear },
      },
    );
  });

  it("reassigns only this bottle without sending changes to the selected wine", () => {
    const item = inventoryItemFixture();
    const submission = submissionFor(item);
    submission.form.designation = "Unsaved correction";
    expect(
      serialized(
        bottleEditPayload(
          { ...submission, wineEditScope: "bottle", wineVintageId: "target-wine" },
          item,
        ),
      ),
    ).toEqual({
      wineEditScope: "bottle",
      expectedWineVintageId: item.wineVintageId,
      wineVintageId: "target-wine",
    });
  });

  it("creates a distinct wine for reassignment even when all descriptions are unchanged", () => {
    const item = inventoryItemFixture();
    const payload = bottleEditPayload({ ...submissionFor(item), wineEditScope: "bottle" }, item);
    expect(payload).toMatchObject({
      wineEditScope: "bottle",
      expectedWineVintageId: item.wineVintageId,
      wine: { wineryName: item.wineryName, designation: item.designation, vintageStatus: "year" },
    });
    expect(payload).not.toHaveProperty("wineVintageId");
    expect(payload).not.toHaveProperty("criticReviews");
    expect(payload).not.toHaveProperty("awards");
  });
});

describe("bottle creation payload", () => {
  it("allows a wine without a proprietary name and generates no invented designation", () => {
    const payload = bottleCreatePayload({
      awards: [],
      criticReviews: [],
      form: {
        ...initialFormState,
        wineryName: "RIKARD",
        grapeVarieties: ["Shiraz"],
        vintageStatus: "year",
        vintageYear: "2022",
      },
    });
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
    const submission = { awards: [], criticReviews: [], form: initialFormState };
    expect(bottleCreatePayload(submission).wine).toMatchObject({
      vintageStatus: "unknown",
      vintageYear: null,
    });
    expect(
      bottleCreatePayload({
        ...submission,
        form: { ...initialFormState, vintageStatus: "non_vintage", vintageYear: "2022" },
      }).wine,
    ).toMatchObject({ vintageStatus: "non_vintage", vintageYear: null });
  });

  it("selects an existing wine without overwriting its shared facts", () => {
    const item = inventoryItemFixture();
    const payload = bottleCreatePayload({ ...submissionFor(item), wineVintageId: "target-wine" });
    expect(payload.wineVintageId).toBe("target-wine");
    expect(payload).not.toHaveProperty("wine");
    expect(payload).not.toHaveProperty("criticReviews");
    expect(payload).not.toHaveProperty("awards");
  });
});

it("never copies original wine review or award IDs when creating a separate wine", () => {
  const item = inventoryItemFixture();
  const payload = bottleEditPayload(
    {
      ...submissionFor(item),
      wineEditScope: "bottle",
      criticReviews: [
        { id: "original-review", reviewSourceName: "Original critic", ratingText: "95" },
        { reviewSourceName: "New critic", ratingText: "91" },
      ],
      awards: [
        { id: "original-award", awardName: "Original show", awardLevel: "Gold" },
        { awardName: "New show", awardLevel: "Silver" },
      ],
    },
    item,
  );
  expect(payload.criticReviews).toEqual([{ reviewSourceName: "New critic", ratingText: "91" }]);
  expect(payload.awards).toEqual([{ awardName: "New show", awardLevel: "Silver" }]);
});
