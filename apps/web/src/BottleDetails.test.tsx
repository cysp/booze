import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState, type ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { BottleDetails } from "./BottleDetails.tsx";
import type { BottleModalSubmitResult } from "./bottle-payload.ts";
import { inventoryItemFixture, locationsFixture, sitesFixture } from "./test/catalogue-fixtures.ts";

function props() {
  return {
    item: inventoryItemFixture(),
    canEdit: true,
    isSaving: false,
    getAuthHeaders: async () => ({}),
    locations: locationsFixture,
    sites: sitesFixture,
    onClose: vi.fn(),
    onDelete: vi.fn(async () => true),
    onStatusChange: vi.fn(async () => true),
    onSubmit: vi.fn(async (): Promise<BottleModalSubmitResult> => ({ ok: true })),
  };
}

describe("read-only bottle details", () => {
  it("lets viewers inspect full historical facts and source evidence without mutation controls", async () => {
    const user = userEvent.setup();
    const shared = props();
    const item = inventoryItemFixture({
      volumeMl: 75_000,
      alcoholPercent: 140,
      vintageYear: 1700,
      bottleNumber: "Physical reference A",
      labelText: "Original label\nOriginal spelling",
      bottleNotes: "Original physical note",
      wineNotes: "Original wine note",
      sourceUrl: "javascript:alert('stored legacy text')",
      criticReviews: [
        {
          id: "review",
          siteId: "site-owner",
          wineVintageId: "vintage-1",
          reviewSourceId: "source",
          reviewSourceName: "Historical critic",
          ratingText: "Legacy rating",
          ratingValue: 300,
          ratingScale: "Historic scale",
          sourceUrl: "https://example.com/review",
          reviewedAt: "1700",
          provenance: "Original guide",
          notes: "Original critic note",
          createdAt: "1700",
          updatedAt: "1701",
        },
      ],
      awards: [
        {
          id: "award",
          siteId: "site-owner",
          wineVintageId: "vintage-1",
          awardName: "Original show",
          awardLevel: "Medal",
          awardYear: 1700,
          awardBody: "Historical body",
          category: "Original category",
          points: 250,
          sourceUrl: "unstructured source",
          provenance: "Original award evidence",
          notes: "Original award note",
          createdAt: "1700",
          updatedAt: "1701",
        },
      ],
    });
    render(<BottleDetails {...shared} item={item} canEdit={false} />);
    expect(screen.getByRole("dialog", { name: "Bottle details" })).toBeVisible();
    expect(screen.getByText("75000")).toBeVisible();
    expect(screen.getByText("140")).toBeVisible();
    expect(screen.getByText("Physical reference A")).toBeVisible();
    for (const text of [
      "Original physical note",
      "Original wine note",
      "Original guide",
      "Original critic note",
      "Original award evidence",
      "Original award note",
      "javascript:alert('stored legacy text')",
      "unstructured source",
    ])
      expect(screen.getByText(text)).toBeVisible();
    expect(screen.getByText("Original label Original spelling")).toBeVisible();
    expect(screen.getByRole("link", { name: "https://example.com/review" })).toHaveAttribute(
      "rel",
      "noopener noreferrer",
    );
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Move" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete bottle" })).not.toBeInTheDocument();
    await user.click(screen.getByText("Record details"));
    expect(screen.getByText("review", { exact: true })).toBeVisible();
    expect(screen.getByText("award", { exact: true })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(shared.onClose).toHaveBeenCalledTimes(1);
    expect(shared.onDelete).not.toHaveBeenCalled();
    expect(shared.onStatusChange).not.toHaveBeenCalled();
    expect(shared.onSubmit).not.toHaveBeenCalled();
  });
  it("uses one active dialog when moving and returns focus to its explicit trigger", async () => {
    const user = userEvent.setup();
    const shared = props();
    render(<BottleDetails {...shared} />);
    await user.click(screen.getByRole("button", { name: "Move" }));
    expect(screen.getByRole("dialog", { name: "Move bottle" })).toBeVisible();
    expect(screen.queryByRole("dialog", { name: "Bottle details" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(shared.onSubmit).not.toHaveBeenCalled();
    expect(shared.onClose).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByRole("dialog", { name: "Bottle details" })).toBeVisible();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Move" })).toHaveFocus();
    });
    expect(shared.onClose).not.toHaveBeenCalled();
  });
  it("requires a dirty action draft to be discarded before another action can be selected", async () => {
    const user = userEvent.setup();
    const shared = props();
    render(<BottleDetails {...shared} />);
    await user.click(screen.getByRole("button", { name: "Edit bottle facts" }));
    await user.type(screen.getByRole("textbox", { name: "Bottle notes" }), "Unsaved");
    expect(screen.queryByRole("button", { name: "Correct shared wine" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    await screen.findByRole("dialog", { name: "Bottle details" });
    await user.click(screen.getByRole("button", { name: "Edit bottle facts" }));
    expect(screen.getByRole("textbox", { name: "Bottle notes" })).toHaveValue("");
    expect(shared.onSubmit).not.toHaveBeenCalled();
  });
  it("shows Restore to inventory for consumed bottles and omits their unavailable Move action", () => {
    render(<BottleDetails {...props()} item={inventoryItemFixture({ status: "consumed" })} />);
    expect(screen.getByRole("button", { name: "Restore to inventory" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Mark consumed" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Move" })).not.toBeInTheDocument();
  });
  it("requires explicit status submission, serializes double clicks and retains failures", async () => {
    const user = userEvent.setup();
    const shared = props();
    let resolveStatus: ((value: boolean) => void) | undefined;
    const onStatusChange = vi.fn(
      async () =>
        new Promise<boolean>((resolve) => {
          resolveStatus = resolve;
        }),
    );
    render(<BottleDetails {...shared} onStatusChange={onStatusChange} />);
    await user.click(screen.getByRole("button", { name: "Mark consumed" }));
    expect(onStatusChange).not.toHaveBeenCalled();
    const submit = screen.getByRole("button", { name: "Mark consumed" });
    await user.dblClick(submit);
    expect(onStatusChange).toHaveBeenCalledTimes(1);
    expect(onStatusChange).toHaveBeenCalledWith("consumed");
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByRole("dialog", { name: "Mark consumed" })).toBeVisible();
    expect(shared.onClose).not.toHaveBeenCalled();
    resolveStatus?.(false);
    expect(await screen.findByText("Bottle status was not updated. Try again.")).toBeVisible();
    expect(submit).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Mark consumed" })).toHaveFocus();
    });
  });
  it("returns to updated details after a confirmed restore", async () => {
    const user = userEvent.setup();
    const shared = props();
    function Harness(): ReactElement {
      const [item, setItem] = useState(inventoryItemFixture({ status: "consumed" }));
      return (
        <BottleDetails
          {...shared}
          item={item}
          onStatusChange={async (status) => {
            setItem((current) => ({ ...current, status }));
            return true;
          }}
        />
      );
    }
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Restore to inventory" }));
    await user.click(screen.getByRole("button", { name: "Restore to inventory" }));
    expect(await screen.findByRole("dialog", { name: "Bottle details" })).toBeVisible();
    expect(screen.getByText("In stock", { exact: true })).toBeVisible();
    expect(screen.getByRole("button", { name: "Mark consumed" })).toBeVisible();
  });
  it("requires delete confirmation and keeps shared facts intact in its stated scope", async () => {
    const user = userEvent.setup();
    const shared = props();
    render(<BottleDetails {...shared} />);
    await user.click(screen.getByRole("button", { name: "Delete bottle" }));
    expect(shared.onDelete).not.toHaveBeenCalled();
    const confirmation = screen.getByRole("alertdialog", { name: "Delete this bottle?" });
    expect(confirmation).toHaveTextContent(
      "The shared wine facts, reviews and awards remain stored.",
    );
    await user.click(within(confirmation).getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Delete bottle" })).toHaveFocus();
    });
    await user.click(screen.getByRole("button", { name: "Delete bottle" }));
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete bottle" }),
    );
    await waitFor(() => {
      expect(shared.onDelete).toHaveBeenCalledTimes(1);
      expect(shared.onClose).toHaveBeenCalledTimes(1);
    });
    expect(shared.onStatusChange).not.toHaveBeenCalled();
    expect(shared.onSubmit).not.toHaveBeenCalled();
  });
});
