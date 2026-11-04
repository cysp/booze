import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  BottleModal,
  type BottleModalSubmit,
  type BottleModalSubmitResult,
} from "./BottleModal.tsx";
import { formStateForItem, initialFormState } from "./inventory-model.ts";
import { inventoryItemFixture, locationsFixture, sitesFixture } from "./test/catalogue-fixtures.ts";

function closeBottle(): void {
  // The containing catalogue owns close state; this test observes confirmation only.
}

function requiredInput(container: HTMLElement, name: string): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>(`[name='${name}']`);
  if (input === null) {
    throw new Error(`Missing input ${name}`);
  }
  return input;
}

async function chooseSharedWineEdit(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole("combobox", { name: "What are you editing?" }));
  await user.click(screen.getByRole("option", { name: "Correct wine details" }));
}

async function submitBottle(): Promise<BottleModalSubmitResult> {
  return { ok: true };
}

describe("BottleModal destructive actions", () => {
  it("keeps an invalid drinking window in the editor until corrected", async () => {
    const user = userEvent.setup();
    const item = inventoryItemFixture();
    const onSubmit =
      vi.fn<(submission: BottleModalSubmit) => Promise<BottleModalSubmitResult>>(submitBottle);
    render(
      <BottleModal
        form={formStateForItem(item)}
        isSaving={false}
        item={item}
        locations={locationsFixture}
        sites={sitesFixture}
        title="Edit bottle"
        onClose={closeBottle}
        onSubmit={onSubmit}
      />,
    );
    await chooseSharedWineEdit(user);
    const from = screen.getByRole("textbox", { name: "Drink from" });
    const to = screen.getByRole("textbox", { name: "Drink to" });
    await user.clear(from);
    await user.type(from, "2038");
    await user.click(screen.getByRole("button", { name: "Save bottle" }));
    expect(await screen.findByText("Drink to must be on or after Drink from.")).toBeVisible();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(from).toHaveValue("2038");
    await user.clear(to);
    await user.type(to, "2040");
    await user.click(screen.getByRole("button", { name: "Save bottle" }));
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });
  });

  it.each([
    { field: "Source", value: "Corrected critic", expectedSourceId: undefined },
    { field: "Rating", value: "96 points", expectedSourceId: "original-source" },
  ])(
    "preserves review provenance when editing $field",
    async ({ field, value, expectedSourceId }) => {
      const user = userEvent.setup();
      const item = inventoryItemFixture({
        criticReviews: [
          {
            id: "original-review",
            siteId: "site-owner",
            wineVintageId: "vintage-1",
            reviewSourceId: "original-source",
            reviewSourceName: "Original critic",
            ratingText: "95 points",
            ratingValue: 95,
            ratingScale: "100 points",
            sourceUrl: "https://example.com/review",
            reviewedAt: null,
            provenance: "Wine guide",
            notes: "Checked by owner",
            createdAt: "2026-07-25T00:00:00.000Z",
            updatedAt: "2026-07-25T00:00:00.000Z",
          },
        ],
      });
      const onSubmit =
        vi.fn<(submission: BottleModalSubmit) => Promise<BottleModalSubmitResult>>(submitBottle);
      render(
        <BottleModal
          form={formStateForItem(item)}
          isSaving={false}
          item={item}
          locations={locationsFixture}
          sites={sitesFixture}
          title="Edit bottle"
          onClose={closeBottle}
          onSubmit={onSubmit}
        />,
      );
      await chooseSharedWineEdit(user);
      const input = screen.getByRole("textbox", { name: new RegExp(`^${field}.*Required`, "iu") });
      await user.clear(input);
      await user.type(input, value);
      await user.click(screen.getByRole("button", { name: "Save bottle" }));
      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledTimes(1);
      });
      expect(onSubmit.mock.calls[0]?.[0].criticReviews[0]).toMatchObject({
        reviewSourceId: expectedSourceId,
        reviewSourceName: field === "Source" ? value : "Original critic",
        ratingText: field === "Rating" ? value : "95 points",
        provenance: "Wine guide",
        notes: "Checked by owner",
      });
      expect(item.criticReviews[0]?.reviewSourceName).toBe("Original critic");
    },
  );

  it("does not offer a position note until a storage location is chosen", async () => {
    const user = userEvent.setup();
    const item = inventoryItemFixture({ locationId: null, location: null, position: null });
    render(
      <BottleModal
        form={formStateForItem(item)}
        isSaving={false}
        item={item}
        locations={locationsFixture}
        sites={sitesFixture}
        title="Edit bottle"
        onClose={closeBottle}
        onSubmit={submitBottle}
      />,
    );
    const position = screen.getByRole("textbox", { name: "Position note" });
    expect(position).toHaveAttribute("aria-disabled", "true");
    expect(position).toHaveAttribute("readonly");
    await user.type(position, "unavailable edit");
    expect(position).toHaveValue("");
    expect(screen.getByText("Choose a location to add a position note.")).toBeVisible();
  });

  it("keeps unsaved changes until discarding is explicitly confirmed", async () => {
    const user = userEvent.setup();
    const item = inventoryItemFixture();
    const onClose = vi.fn<() => void>();
    render(
      <BottleModal
        form={formStateForItem(item)}
        isSaving={false}
        item={item}
        locations={locationsFixture}
        sites={sitesFixture}
        title="Edit bottle"
        onClose={onClose}
        onSubmit={submitBottle}
      />,
    );
    await chooseSharedWineEdit(user);
    const winery = screen.getByRole("textbox", { name: /Winery/iu });
    await user.type(winery, " corrected");
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByRole("alertdialog", { name: "Discard unsaved changes?" })).toBeVisible();
    expect(onClose).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(winery).toHaveValue(`${item.wineryName} corrected`);

    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);

    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  it("serializes saving with consume, deletion, closing, and repeated form submission", async () => {
    const user = userEvent.setup();
    const item = inventoryItemFixture();
    const onClose = vi.fn<() => void>();
    const onMarkConsumed = vi.fn(async () => true);
    const onDelete = vi.fn(async () => true);
    let resolveSave: ((result: BottleModalSubmitResult) => void) | undefined;
    const onSubmit = vi.fn(
      async () =>
        new Promise<BottleModalSubmitResult>((resolve) => {
          resolveSave = resolve;
        }),
    );
    render(
      <BottleModal
        form={formStateForItem(item)}
        isSaving={false}
        item={item}
        locations={locationsFixture}
        sites={sitesFixture}
        title="Edit bottle"
        onClose={onClose}
        onSubmit={onSubmit}
        onDelete={onDelete}
        onMarkConsumed={onMarkConsumed}
      />,
    );
    await chooseSharedWineEdit(user);
    await user.click(screen.getByRole("button", { name: "Save bottle" }));
    const winery = screen.getByRole("textbox", { name: /Winery/iu });
    expect(winery).toBeDisabled();
    await user.type(winery, "unavailable edit");
    expect(winery).toHaveValue(item.wineryName ?? "");
    expect(screen.getByRole("button", { name: "Mark drunk" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete bottle" })).toBeDisabled();
    const form = winery.closest("form");
    if (form === null) {
      throw new Error("Missing bottle form");
    }
    fireEvent.submit(form);
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(onMarkConsumed).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();

    resolveSave?.({ ok: false, message: "Temporary failure" });
    expect(await screen.findByText("Temporary failure")).toBeVisible();
    expect(winery).toBeEnabled();
    expect(screen.getByRole("button", { name: "Mark drunk" })).toBeEnabled();
  });

  it("requires saving an edited draft before marking the bottle drunk", async () => {
    const user = userEvent.setup();
    const item = inventoryItemFixture();
    const onMarkConsumed = vi.fn(async () => true);
    render(
      <BottleModal
        form={formStateForItem(item)}
        isSaving={false}
        item={item}
        locations={locationsFixture}
        sites={sitesFixture}
        title="Edit bottle"
        onClose={closeBottle}
        onSubmit={submitBottle}
        onMarkConsumed={onMarkConsumed}
      />,
    );
    await user.type(screen.getByRole("textbox", { name: "Bottle notes" }), "Opened tonight");
    expect(screen.getByRole("button", { name: "Mark drunk" })).toBeDisabled();
    expect(screen.getByText("Save your changes before marking this bottle drunk.")).toBeVisible();
    expect(onMarkConsumed).not.toHaveBeenCalled();
  });

  it("rejects malformed numbers and preserves the draft instead of silently truncating them", async () => {
    const user = userEvent.setup();
    const item = inventoryItemFixture();
    const onSubmit =
      vi.fn<(submission: BottleModalSubmit) => Promise<BottleModalSubmitResult>>(submitBottle);
    render(
      <BottleModal
        form={formStateForItem(item)}
        isSaving={false}
        item={item}
        locations={locationsFixture}
        sites={sitesFixture}
        title="Edit bottle"
        onClose={closeBottle}
        onSubmit={onSubmit}
      />,
    );
    await chooseSharedWineEdit(user);
    const vintage = screen.getByRole("textbox", { name: /^Vintage/u });
    await user.clear(vintage);
    await user.type(vintage, "2023 typo");
    await user.click(screen.getByRole("button", { name: "Save bottle" }));

    expect(
      await screen.findByText("Vintage must be a whole year from 1800 to 2200."),
    ).toBeVisible();
    expect(vintage).toHaveValue("2023 typo");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("requires explicit AlertDialog confirmation before deleting", async () => {
    const user = userEvent.setup();
    const item = inventoryItemFixture();
    const onDelete = vi.fn(async () => true);

    render(
      <BottleModal
        form={formStateForItem(item)}
        isSaving={false}
        item={item}
        locations={locationsFixture}
        sites={sitesFixture}
        title="Edit bottle"
        onClose={closeBottle}
        onDelete={onDelete}
        onSubmit={submitBottle}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Delete bottle" }));
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog", { name: "Delete this bottle?" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onDelete).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Delete bottle" }));
    await user.click(
      within(screen.getByRole("alertdialog", { name: "Delete this bottle?" })).getByRole("button", {
        name: "Delete bottle",
      }),
    );
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("preserves dirty scalar and repeatable values across parent loading renders", async () => {
    const user = userEvent.setup();
    const item = inventoryItemFixture();
    const props = {
      form: formStateForItem(item),
      item,
      locations: locationsFixture,
      sites: sitesFixture,
      title: "Edit bottle",
      onClose: closeBottle,
      onSubmit: submitBottle,
    } as const;
    const { container, rerender } = render(<BottleModal {...props} isSaving={false} />);
    await chooseSharedWineEdit(user);

    const winery = screen.getByRole("textbox", { name: /Winery/iu });
    await user.clear(winery);
    await user.type(winery, "Unsaved Adversarial Winery");

    await user.click(screen.getByRole("button", { name: "Add review" }));
    await user.type(screen.getByRole("textbox", { name: /^Source.*Required/iu }), "Local critic");
    await user.type(screen.getByRole("textbox", { name: /Rating.*Required/iu }), "96 points");

    await user.click(screen.getByRole("button", { name: "Add award" }));
    await user.type(requiredInput(container, "awards.0.awardLevel"), "Gold");
    await user.type(requiredInput(container, "awards.0.awardName"), "Local show");

    rerender(<BottleModal {...props} isSaving />);

    expect(winery).toHaveValue("Unsaved Adversarial Winery");
    expect(container.querySelector("[name='criticReviews.0.reviewSourceName']")).toHaveValue(
      "Local critic",
    );
    expect(container.querySelector("[name='criticReviews.0.ratingText']")).toHaveValue("96 points");
    expect(container.querySelector("[name='awards.0.awardLevel']")).toHaveValue("Gold");
    expect(container.querySelector("[name='awards.0.awardName']")).toHaveValue("Local show");
  });
});

describe("BottleModal wine identity", () => {
  it("saves producer and grape facts without a proprietary name", async () => {
    const user = userEvent.setup();
    const onSubmit =
      vi.fn<(submission: BottleModalSubmit) => Promise<BottleModalSubmitResult>>(submitBottle);
    render(
      <BottleModal
        form={{
          ...initialFormState,
          siteId: "site-owner",
          wineryName: "RIKARD",
          grapeVarieties: "Shiraz",
        }}
        isSaving={false}
        locations={locationsFixture}
        sites={sitesFixture}
        title="Add bottle"
        onClose={closeBottle}
        onSubmit={onSubmit}
      />,
    );
    expect(screen.getByRole("textbox", { name: "Designation (optional)" })).not.toBeRequired();
    expect(screen.getByText("Catalogue title: RIKARD Shiraz")).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Vintage status" })).toHaveTextContent(
      "Unknown vintage",
    );
    await user.click(screen.getByRole("button", { name: "Save bottle" }));
    expect(onSubmit.mock.calls[0]?.[0].allowUnidentified).toBe(false);
    expect(onSubmit.mock.calls[0]?.[0].form).toMatchObject({
      designation: "",
      vintageStatus: "unknown",
      vintageYear: "",
    });
  });

  it("offers an explicit action to save an unidentified wine", async () => {
    const user = userEvent.setup();
    const onSubmit =
      vi.fn<(submission: BottleModalSubmit) => Promise<BottleModalSubmitResult>>(submitBottle);
    render(
      <BottleModal
        form={{ ...initialFormState, siteId: "site-owner" }}
        isSaving={false}
        locations={locationsFixture}
        sites={sitesFixture}
        title="Add bottle"
        onClose={closeBottle}
        onSubmit={onSubmit}
      />,
    );
    expect(screen.queryByRole("button", { name: "Save bottle" })).not.toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(/Wine details are incomplete/u)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Save as unidentified wine" }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ allowUnidentified: true }));
  });

  it("locks shared facts until an explicit correction and shows every affected bottle", async () => {
    const user = userEvent.setup();
    const item = inventoryItemFixture({ wineBottleCount: 7 });
    const onSubmit =
      vi.fn<(submission: BottleModalSubmit) => Promise<BottleModalSubmitResult>>(submitBottle);
    render(
      <BottleModal
        form={formStateForItem(item)}
        item={item}
        isSaving={false}
        locations={locationsFixture}
        sites={sitesFixture}
        title="Edit bottle"
        onClose={closeBottle}
        onSubmit={onSubmit}
      />,
    );
    const winery = screen.getByRole("textbox", { name: "Winery" });
    expect(winery).toHaveAttribute("aria-disabled", "true");
    expect(winery).toHaveAttribute("readonly");
    await user.type(winery, "unavailable edit");
    expect(winery).toHaveValue(item.wineryName ?? "");
    const notes = screen.getByRole("textbox", { name: "Bottle notes" });
    expect(notes).not.toHaveAttribute("aria-disabled", "true");
    expect(notes).not.toHaveAttribute("readonly");
    await chooseSharedWineEdit(user);
    expect(screen.getByText("Corrections will update all 7 linked bottles.")).toBeVisible();
    await user.type(screen.getByRole("textbox", { name: "Designation (optional)" }), " Reserve");
    await user.click(screen.getByRole("button", { name: "Save bottle" }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ wineEditScope: "shared" }));
  });

  it("offers a wine option without in-stock inventory and locks that wine's details", async () => {
    const user = userEvent.setup();
    const item = inventoryItemFixture();
    const target = {
      wineVintageId: "target-wine",
      siteId: item.siteId,
      wineryName: "Producer",
      displayName: "Target Shiraz",
      vintageYear: 2023,
      vintageStatus: item.vintageStatus,
      vintageLabel: "2023",
      grapeVarieties: ["Shiraz"],
      region: null,
    };
    const otherSite = {
      ...target,
      siteId: "site-editor",
      wineVintageId: "other-site",
      displayName: "Hidden wine",
    };
    const onSubmit =
      vi.fn<(submission: BottleModalSubmit) => Promise<BottleModalSubmitResult>>(submitBottle);
    render(
      <BottleModal
        form={formStateForItem(item)}
        item={item}
        wines={[target, otherSite]}
        isSaving={false}
        locations={locationsFixture}
        sites={sitesFixture}
        title="Edit bottle"
        onClose={closeBottle}
        onSubmit={onSubmit}
      />,
    );
    await user.click(screen.getByRole("combobox", { name: "What are you editing?" }));
    await user.click(screen.getByRole("option", { name: "This bottle is a different wine" }));
    await user.click(screen.getByRole("combobox", { name: "Wine record" }));
    expect(screen.queryByRole("option", { name: /Hidden wine/u })).not.toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: /2023 Target Shiraz/u }));
    expect(screen.queryByRole("textbox", { name: "Winery" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Critic reviews" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Awards" })).not.toBeInTheDocument();
    expect(
      within(screen.getByRole("region", { name: "Selected wine details" })).getByRole("heading", {
        name: "2023 Target Shiraz",
      }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Save bottle" }));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ wineEditScope: "bottle", wineVintageId: "target-wine" }),
    );
  });
});

it("keeps new-wine evidence separate and restores each draft when switching edit modes", async () => {
  const user = userEvent.setup();
  const item = inventoryItemFixture({
    criticReviews: [
      {
        id: "old-review",
        siteId: "site-owner",
        wineVintageId: "vintage-1",
        reviewSourceId: "old-source",
        reviewSourceName: "Original critic",
        ratingText: "95 points",
        ratingValue: 95,
        ratingScale: "100 points",
        sourceUrl: null,
        reviewedAt: null,
        provenance: null,
        notes: null,
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
      },
    ],
    awards: [
      {
        id: "old-award",
        siteId: "site-owner",
        wineVintageId: "vintage-1",
        awardName: "Original show",
        awardLevel: "Gold",
        awardYear: null,
        awardBody: null,
        category: null,
        points: null,
        sourceUrl: null,
        provenance: null,
        notes: null,
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
      },
    ],
  });
  const onSubmit =
    vi.fn<(submission: BottleModalSubmit) => Promise<BottleModalSubmitResult>>(submitBottle);
  const { container } = render(
    <BottleModal
      form={formStateForItem(item)}
      item={item}
      isSaving={false}
      locations={locationsFixture}
      sites={sitesFixture}
      title="Edit bottle"
      onClose={closeBottle}
      onSubmit={onSubmit}
    />,
  );
  await user.click(screen.getByRole("combobox", { name: "What are you editing?" }));
  await user.click(screen.getByRole("option", { name: "This bottle is a different wine" }));
  expect(screen.queryByRole("textbox", { name: /^Source.*Required/iu })).not.toBeInTheDocument();
  expect(container.querySelector("[name='awards.0.awardName']")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Add review" }));
  await user.type(screen.getByRole("textbox", { name: /^Source.*Required/iu }), "New critic");
  await user.type(screen.getByRole("textbox", { name: /Rating.*Required/iu }), "91 points");
  await user.click(screen.getByRole("button", { name: "Add award" }));
  await user.type(requiredInput(container, "awards.0.awardName"), "New show");
  await user.type(requiredInput(container, "awards.0.awardLevel"), "Silver");
  await chooseSharedWineEdit(user);
  expect(screen.getByRole("textbox", { name: /^Source.*Required/iu })).toHaveValue(
    "Original critic",
  );
  expect(requiredInput(container, "awards.0.awardName")).toHaveValue("Original show");
  await user.click(screen.getByRole("combobox", { name: "What are you editing?" }));
  await user.click(screen.getByRole("option", { name: "This bottle is a different wine" }));
  expect(screen.getByRole("textbox", { name: /^Source.*Required/iu })).toHaveValue("New critic");
  expect(requiredInput(container, "awards.0.awardName")).toHaveValue("New show");
  await user.click(screen.getByRole("button", { name: "Save bottle" }));
  expect(onSubmit.mock.calls[0]?.[0].criticReviews).toHaveLength(1);
  expect(onSubmit.mock.calls[0]?.[0].criticReviews[0]).toMatchObject({
    reviewSourceName: "New critic",
    ratingText: "91 points",
  });
  expect(onSubmit.mock.calls[0]?.[0].criticReviews[0]?.id).toBeUndefined();
  expect(onSubmit.mock.calls[0]?.[0].awards).toHaveLength(1);
  expect(onSubmit.mock.calls[0]?.[0].awards[0]).toMatchObject({
    awardName: "New show",
    awardLevel: "Silver",
  });
  expect(onSubmit.mock.calls[0]?.[0].awards[0]?.id).toBeUndefined();
});
