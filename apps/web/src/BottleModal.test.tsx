import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BottleModal } from "./BottleModal.tsx";
import type {
  BottleFormAction,
  BottleModalSubmit,
  BottleModalSubmitResult,
} from "./bottle-payload.ts";
import { initialFormState } from "./inventory-model.ts";
import { inventoryItemFixture, locationsFixture, sitesFixture } from "./test/catalogue-fixtures.ts";

const item = inventoryItemFixture();
const auth = async () => ({});
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ data: [], totalCount: 0, nextPageToken: null })),
  );
});
afterEach(() => vi.unstubAllGlobals());
async function successfulSave(): Promise<BottleModalSubmitResult> {
  return { ok: true };
}
function close(): void {
  /* The parent owns the selected action. */
}
function renderAction(
  action: BottleFormAction,
  onSubmit = vi.fn<(input: BottleModalSubmit) => Promise<BottleModalSubmitResult>>(successfulSave),
) {
  return {
    onSubmit,
    ...render(
      <BottleModal
        getAuthHeaders={auth}
        action={action}
        isSaving={false}
        locations={locationsFixture}
        sites={sitesFixture}
        onClose={close}
        onSubmit={onSubmit}
      />,
    ),
  };
}
async function openReference(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByText("Wine reference and evidence"));
}

describe("focused bottle action drafts", () => {
  it("shows only the fields owned by the chosen action", () => {
    renderAction({ kind: "edit-bottle", item });
    expect(screen.getByRole("textbox", { name: "Bottle notes" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Bottle number" })).toBeVisible();
    expect(screen.queryByRole("textbox", { name: "Winery" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Bottle location" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mark consumed" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete bottle" })).not.toBeInTheDocument();
  });
  it("allows notes-only editing of a historical 75000 ml bottle without validating or resubmitting it", async () => {
    const user = userEvent.setup();
    const historical = inventoryItemFixture({
      volumeMl: 75_000,
      alcoholPercent: 140,
      vintageYear: 1700,
    });
    const { onSubmit } = renderAction({ kind: "edit-bottle", item: historical });
    expect(screen.getByRole("textbox", { name: /Bottle size/u })).toHaveValue("75000");
    await user.type(screen.getByRole("textbox", { name: "Bottle notes" }), "Inspected");
    await user.click(screen.getByRole("button", { name: "Save bottle facts" }));
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        kind: "edit-bottle",
        bottle: { notes: "Inspected" },
      });
    });
    expect(historical.volumeMl).toBe(75_000);
  });
  it("rejects a changed invalid bottle size and retains the draft", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderAction({ kind: "edit-bottle", item });
    const volume = screen.getByRole("textbox", { name: /Bottle size/u });
    await user.clear(volume);
    await user.type(volume, "2023 typo");
    await user.click(screen.getByRole("button", { name: "Save bottle facts" }));
    expect(
      await within(screen.getByRole("dialog")).findByText(
        "Bottle size must be a whole number from 1 to 30000 ml.",
      ),
    ).toBeVisible();
    expect(volume).toHaveValue("2023 typo");
    expect(onSubmit).not.toHaveBeenCalled();
  });
  it("does not offer a position note without a storage location", () => {
    renderAction({
      kind: "move",
      item: inventoryItemFixture({
        storageLocationId: null,
        storageLocationName: null,
        positionHint: null,
      }),
    });
    expect(screen.getByRole("textbox", { name: "Position note" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByText("Choose a location to add a position note.")).toBeVisible();
  });
  it("retains dirty fields until discard is confirmed and restores focus when discard is cancelled", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn<() => void>();
    render(
      <BottleModal
        getAuthHeaders={auth}
        action={{ kind: "edit-bottle", item }}
        isSaving={false}
        locations={locationsFixture}
        sites={sitesFixture}
        onClose={onClose}
        onSubmit={successfulSave}
      />,
    );
    const notes = screen.getByRole("textbox", { name: "Bottle notes" });
    await user.type(notes, "Unsaved");
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByRole("alertdialog", { name: "Discard unsaved changes?" })).toBeVisible();
    expect(onClose).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(notes).toHaveValue("Unsaved");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    });
    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });
  it("serializes saving, repeated submit and close; failed saves retain the draft", async () => {
    const user = userEvent.setup();
    let resolveSave: ((result: BottleModalSubmitResult) => void) | undefined;
    const onSubmit = vi.fn(
      async () =>
        new Promise<BottleModalSubmitResult>((resolve) => {
          resolveSave = resolve;
        }),
    );
    const onClose = vi.fn<() => void>();
    render(
      <BottleModal
        getAuthHeaders={auth}
        action={{ kind: "edit-bottle", item }}
        isSaving={false}
        locations={locationsFixture}
        sites={sitesFixture}
        onClose={onClose}
        onSubmit={onSubmit}
      />,
    );
    const notes = screen.getByRole("textbox", { name: "Bottle notes" });
    await user.type(notes, "Keep me");
    await user.click(screen.getByRole("button", { name: "Save bottle facts" }));
    expect(notes).toBeDisabled();
    const form = notes.closest("form");
    if (form === null) throw new Error("Missing form");
    fireEvent.submit(form);
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    resolveSave?.({ ok: false, message: "Temporary failure" });
    expect(await within(screen.getByRole("dialog")).findByText("Temporary failure")).toBeVisible();
    expect(notes).toBeEnabled();
    expect(notes).toHaveValue("Keep me");
  });
  it("keeps dirty scalar and evidence drafts across parent loading renders", async () => {
    const user = userEvent.setup();
    const props = {
      action: { kind: "correct-wine", item } as const,
      locations: locationsFixture,
      sites: sitesFixture,
      onClose: close,
      onSubmit: successfulSave,
    };
    const { rerender } = render(<BottleModal getAuthHeaders={auth} {...props} isSaving={false} />);
    const winery = screen.getByRole("textbox", { name: "Winery" });
    await user.clear(winery);
    await user.type(winery, "Unsaved winery");
    await openReference(user);
    await user.click(screen.getByRole("button", { name: "Add review" }));
    await user.type(screen.getByRole("textbox", { name: /^Source.*Required/iu }), "Local critic");
    await user.type(screen.getByRole("textbox", { name: /^Rating.*Required/iu }), "96 points");
    await user.click(screen.getByRole("button", { name: "Add award" }));
    await user.type(
      screen.getByRole("textbox", { name: /^Competition.*Required/iu }),
      "Local show",
    );
    rerender(<BottleModal getAuthHeaders={auth} {...props} isSaving />);
    expect(winery).toHaveValue("Unsaved winery");
    expect(screen.getByRole("textbox", { name: /^Source.*Required/iu })).toHaveValue(
      "Local critic",
    );
    expect(screen.getByRole("textbox", { name: /^Competition.*Required/iu })).toHaveValue(
      "Local show",
    );
  });
});

describe("explicit wine operations", () => {
  it("shows affected count and rejects contradictory drinking-window changes", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderAction({
      kind: "correct-wine",
      item: inventoryItemFixture({ wineBottleCount: 7 }),
    });
    expect(screen.getByText("Corrections will update all 7 linked bottles.")).toBeVisible();
    await openReference(user);
    const from = screen.getByRole("textbox", { name: "Drink from" });
    const to = screen.getByRole("textbox", { name: "Drink to" });
    await user.clear(from);
    await user.type(from, "2038");
    await user.click(screen.getByRole("button", { name: "Save wine corrections" }));
    expect(
      await within(screen.getByRole("dialog")).findByText(
        "Drink to must be on or after Drink from.",
      ),
    ).toBeVisible();
    expect(onSubmit).not.toHaveBeenCalled();
    await user.clear(to);
    await user.type(to, "2040");
    await user.click(screen.getByRole("button", { name: "Save wine corrections" }));
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "correct-wine",
          wine: { drinkFromYear: 2038, drinkToYear: 2040 },
        }),
      );
    });
  });
  it("does not validate or resubmit unchanged historical wine facts during a note correction", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderAction({
      kind: "correct-wine",
      item: inventoryItemFixture({
        vintageYear: 1700,
        alcoholPercent: 140,
        drinkFromYear: 1600,
        drinkToYear: 1500,
      }),
    });
    await openReference(user);
    await user.type(
      screen.getByRole("textbox", { name: "Wine notes" }),
      "Historical record inspected",
    );
    await user.click(screen.getByRole("button", { name: "Save wine corrections" }));
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        kind: "correct-wine",
        wine: { notes: "Historical record inspected" },
        allowUnidentified: false,
      });
    });
  });
  it.each([
    ["Source", "Corrected critic", undefined],
    ["Rating", "96 points", "original-source"],
  ] as const)("preserves provenance when correcting %s", async (field, value, expectedSourceId) => {
    const user = userEvent.setup();
    const historical = inventoryItemFixture({
      criticReviews: [
        {
          id: "original-review",
          siteId: item.siteId,
          wineVintageId: item.wineVintageId,
          reviewSourceId: "original-source",
          reviewSourceName: "Original critic",
          ratingText: "95 points",
          ratingValue: 95,
          ratingScale: "100 points",
          sourceUrl: "https://example.com/review",
          reviewedAt: null,
          provenance: "Wine guide",
          notes: "Checked by owner",
          createdAt: "2026-07-25",
          updatedAt: "2026-07-25",
        },
      ],
    });
    const { onSubmit } = renderAction({ kind: "correct-wine", item: historical });
    await openReference(user);
    const input = screen.getByRole("textbox", { name: new RegExp(`^${field}.*Required`, "iu") });
    await user.clear(input);
    await user.type(input, value);
    await user.click(screen.getByRole("button", { name: "Save wine corrections" }));
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "correct-wine",
          criticReviews: [
            expect.objectContaining({
              reviewSourceId: expectedSourceId,
              reviewSourceName: field === "Source" ? value : "Original critic",
              ratingText: field === "Rating" ? value : "95 points",
              provenance: "Wine guide",
              notes: "Checked by owner",
            }),
          ],
        }),
      );
    });
    expect(historical.criticReviews[0]?.reviewSourceName).toBe("Original critic");
  });
  it("requires complete new evidence and focuses its error", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderAction({ kind: "correct-wine", item });
    await openReference(user);
    await user.click(screen.getByRole("button", { name: "Add review" }));
    await user.click(screen.getByRole("button", { name: "Save wine corrections" }));
    expect(
      await within(screen.getByRole("dialog")).findByText("Rating is required."),
    ).toBeVisible();
    expect(onSubmit).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: /^Source.*Required/iu })).toHaveFocus();
    });
  });
  it("starts a reassignment with blank wine facts and evidence", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderAction({ kind: "reassign", item });
    expect(screen.getByRole("textbox", { name: "Winery" })).toHaveValue("");
    expect(screen.queryByRole("textbox", { name: "Bottle notes" })).not.toBeInTheDocument();
    await openReference(user);
    expect(screen.getByText("No critic reviews recorded.")).toBeVisible();
    expect(screen.getByText("No awards recorded.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Save as unidentified wine" }));
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "reassign",
          wine: expect.objectContaining<Record<string, unknown>>({
            wineryName: "",
            grapeVarieties: [],
            alcoholPercent: null,
            drinkFromYear: null,
            drinkToYear: null,
          }) as unknown,
          criticReviews: [],
          awards: [],
          allowUnidentified: true,
        }),
      );
    });
  });
  it("chooses an existing zero-stock wine without validating or submitting its facts", async () => {
    const user = userEvent.setup();
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
    const onSubmit =
      vi.fn<(input: BottleModalSubmit) => Promise<BottleModalSubmitResult>>(successfulSave);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          data: [
            target,
            {
              ...target,
              siteId: "other-site",
              wineVintageId: "hidden-wine",
              displayName: "Hidden wine",
            },
          ],
          totalCount: 2,
          nextPageToken: null,
        }),
      ),
    );
    render(
      <BottleModal
        getAuthHeaders={auth}
        action={{ kind: "reassign", item }}
        isSaving={false}
        locations={locationsFixture}
        sites={sitesFixture}
        onClose={close}
        onSubmit={onSubmit}
      />,
    );
    await user.click(screen.getByRole("combobox", { name: "Wine record" }));
    expect(await screen.findByRole("option", { name: /2023 Target Shiraz/u })).toBeVisible();
    expect(screen.queryByRole("option", { name: /Hidden wine/u })).not.toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: /2023 Target Shiraz/u }));
    expect(screen.queryByRole("textbox", { name: "Winery" })).not.toBeInTheDocument();
    expect(screen.queryByText("Wine reference and evidence")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reassign bottle" }));
    expect(onSubmit).toHaveBeenCalledWith({ kind: "reassign", wineVintageId: "target-wine" });
  });
  it("saves manual producer and grape facts without AI or an invented designation", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderAction({
      kind: "add",
      form: {
        ...initialFormState,
        siteId: item.siteId,
        wineryName: "RIKARD",
        grapeVarieties: ["Shiraz"],
      },
    });
    expect(screen.getByText("Catalogue title: RIKARD Shiraz")).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Designation (optional)" })).not.toBeRequired();
    await user.click(screen.getByRole("button", { name: "Save bottle" }));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "add",
        allowUnidentified: false,
        form: expect.objectContaining<Record<string, unknown>>({
          designation: "",
          vintageStatus: "unknown",
          vintageYear: "",
        }) as unknown,
      }),
    );
  });
});
