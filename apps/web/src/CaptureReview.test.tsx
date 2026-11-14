import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { CaptureReviewCandidate } from "../shared/capture-review.ts";
import { describe, expect, it, vi } from "vitest";

import { CaptureReview } from "./CaptureReview.tsx";
import { captureFixture } from "./test/catalogue-fixtures.ts";
import type { CaptureRunResource } from "./inventory-model.ts";

const run = {
  id: "run-1",
  status: "needs_review",
  extractionR2Key: null,
  extractionContentType: null,
  extractionSizeBytes: null,
  importCandidate: {
    wine: {
      wineryName: "Rowlee",
      displayName: "Reserve Shiraz",
      vintageYear: 2023,
      alcoholPercent: 13.5,
      grapeVarieties: ["Shiraz", "Cabernet Sauvignon"],
      notes: "Extraction disagreements: two possible vintages",
      labelText: "Front label\nBack label",
    },
    bottle: { volumeMl: 750, lotCode: "L42" },
  },
  matchResult: null,
  importResult: { reviewReasons: ["The photos disagree on the vintage."] },
  errorMessage: null,
  errorDetailR2Key: null,
  errorDetailContentType: null,
  errorDetailSizeBytes: null,
  createdAt: "2026-07-25T00:00:00Z",
  completedAt: null,
} satisfies CaptureRunResource;

describe("capture review", () => {
  it("shows extracted facts and disagreement reasons before import", () => {
    render(
      <CaptureReview
        wines={[]}
        capture={captureFixture({ latestRun: run })}
        canWrite={false}
        disabled={false}
        onDirtyChange={vi.fn<(dirty: boolean) => void>()}
        onBusyChange={vi.fn<(busy: boolean) => void>()}
        onImport={async () => ({ ok: true })}
        onSaveReview={async (_id, reviewRevision, reviewCandidate) => ({
          ok: true,
          reviewRevision,
          reviewCandidate,
        })}
      />,
    );

    expect(screen.getByText("The photos disagree on the vintage.")).toBeVisible();
    screen.getByText("Original extracted facts").click();
    expect(screen.getByText("2023")).toBeVisible();
    expect(screen.getByText("13.5")).toBeVisible();
    expect(screen.getByText("Shiraz, Cabernet Sauvignon")).toBeVisible();
    expect(screen.getByText("750")).toBeVisible();
    expect(screen.getByText("L42")).toBeVisible();
    expect(
      screen.getByText("Extraction disagreements: two possible vintages", { selector: "dd" }),
    ).toBeVisible();
  });

  it("names unavailable evidence instead of presenting an empty review", () => {
    render(
      <CaptureReview
        wines={[]}
        capture={captureFixture({ latestRun: null })}
        canWrite={false}
        disabled={false}
        onDirtyChange={vi.fn<(dirty: boolean) => void>()}
        onBusyChange={vi.fn<(busy: boolean) => void>()}
        onImport={async () => ({ ok: true })}
        onSaveReview={async (_id, reviewRevision, reviewCandidate) => ({
          ok: true,
          reviewRevision,
          reviewCandidate,
        })}
      />,
    );
    screen.getByText("Original extracted facts").click();
    expect(
      screen.getByText(
        "Extracted facts are unavailable. Enter details manually or retry extraction.",
      ),
    ).toBeVisible();
  });
});

it("preserves unsaved corrections when a newer extraction arrives", async () => {
  const user = userEvent.setup();
  const onImport = vi.fn(async () => ({ ok: true as const }));
  const common = {
    canWrite: true,
    disabled: false,
    onDirtyChange: vi.fn<(dirty: boolean) => void>(),
    onBusyChange: vi.fn<(busy: boolean) => void>(),
    onImport,
    onSaveReview: async (
      _id: string,
      reviewRevision: number,
      reviewCandidate: CaptureReviewCandidate,
    ) => ({ ok: true as const, reviewRevision, reviewCandidate }),
  };
  const { rerender } = render(
    <CaptureReview wines={[]} {...common} capture={captureFixture({ latestRun: run })} />,
  );
  await user.clear(screen.getByRole("textbox", { name: "Producer / winery" }));
  await user.type(screen.getByRole("textbox", { name: "Producer / winery" }), "Manual producer");
  rerender(
    <CaptureReview
      wines={[]}
      {...common}
      capture={captureFixture({
        latestRun: {
          ...run,
          id: "run-2",
          importCandidate: { wine: { wineryName: "New extraction" }, bottle: {} },
        },
      })}
    />,
  );
  expect(screen.getByRole("textbox", { name: "Producer / winery" })).toHaveValue("Manual producer");
  expect(screen.getByRole("button", { name: "Create new" })).toBeDisabled();
  expect(onImport).not.toHaveBeenCalled();
});

it("offers explicit recovery from concurrent corrections without silently discarding edits", async () => {
  const user = userEvent.setup();
  const common = {
    canWrite: true,
    disabled: false,
    onDirtyChange: vi.fn<(dirty: boolean) => void>(),
    onBusyChange: vi.fn<(busy: boolean) => void>(),
    onImport: async () => ({ ok: true as const }),
    onSaveReview: async (
      _id: string,
      reviewRevision: number,
      reviewCandidate: CaptureReviewCandidate,
    ) => ({ ok: true as const, reviewRevision, reviewCandidate }),
  };
  const { rerender } = render(
    <CaptureReview wines={[]} {...common} capture={captureFixture({ latestRun: run })} />,
  );
  await user.type(screen.getByRole("textbox", { name: "Producer / winery" }), " local edit");
  rerender(
    <CaptureReview
      wines={[]}
      {...common}
      capture={captureFixture({
        latestRun: run,
        reviewRevision: 1,
        reviewCandidate: {
          wine: { wineryName: "Other editor", designation: "", grapeVarieties: ["Shiraz"] },
          bottle: {},
        },
      })}
    />,
  );
  expect(screen.getByRole("textbox", { name: "Producer / winery" })).toHaveValue(
    "Rowlee local edit",
  );
  await user.click(screen.getByRole("button", { name: "Load latest corrections" }));
  expect(screen.getByRole("textbox", { name: "Producer / winery" })).toHaveValue("Other editor");
  expect(screen.getByRole("button", { name: "Save corrections" })).toBeDisabled();
});

it("adopts newer extraction after local changes are undone instead of importing unseen facts", async () => {
  const user = userEvent.setup();
  const common = {
    wines: [],
    canWrite: true,
    disabled: false,
    onDirtyChange: vi.fn<(dirty: boolean) => void>(),
    onBusyChange: vi.fn<(busy: boolean) => void>(),
    onImport: async () => ({ ok: true as const }),
    onSaveReview: async (
      _id: string,
      reviewRevision: number,
      reviewCandidate: CaptureReviewCandidate,
    ) => ({ ok: true as const, reviewRevision, reviewCandidate }),
  };
  const { rerender } = render(
    <CaptureReview {...common} capture={captureFixture({ latestRun: run })} />,
  );
  await user.type(screen.getByRole("textbox", { name: "Producer / winery" }), " correction");
  rerender(
    <CaptureReview
      {...common}
      capture={captureFixture({
        latestRun: {
          ...run,
          id: "new-run",
          importCandidate: {
            wine: { wineryName: "New evidence", grapeVarieties: ["Shiraz"] },
            bottle: {},
          },
        },
      })}
    />,
  );
  expect(screen.getByRole("textbox", { name: "Producer / winery" })).toHaveValue(
    "Rowlee correction",
  );
  await user.clear(screen.getByRole("textbox", { name: "Producer / winery" }));
  await user.type(screen.getByRole("textbox", { name: "Producer / winery" }), "Rowlee");
  expect(screen.getByRole("textbox", { name: "Producer / winery" })).toHaveValue("New evidence");
});

it("adopts evidence arriving later for the same run when the draft is clean", () => {
  const common = {
    wines: [],
    canWrite: true,
    disabled: false,
    onDirtyChange: vi.fn<(dirty: boolean) => void>(),
    onBusyChange: vi.fn<(busy: boolean) => void>(),
    onImport: async () => ({ ok: true as const }),
    onSaveReview: async (
      _id: string,
      reviewRevision: number,
      reviewCandidate: CaptureReviewCandidate,
    ) => ({ ok: true as const, reviewRevision, reviewCandidate }),
  };
  const { rerender } = render(
    <CaptureReview
      {...common}
      capture={captureFixture({ latestRun: { ...run, importCandidate: null } })}
    />,
  );
  rerender(<CaptureReview {...common} capture={captureFixture({ latestRun: run })} />);
  expect(screen.getByRole("textbox", { name: "Producer / winery" })).toHaveValue("Rowlee");
});

it("preserves literal grape names while saving other capture corrections", async () => {
  const user = userEvent.setup();
  const grapeVarieties = ["Grenache (Garnacha, Alicante)", 'Muscat "Blanc"', "日本の品種"];
  const onSaveReview = vi.fn(
    async (_id: string, reviewRevision: number, reviewCandidate: CaptureReviewCandidate) => ({
      ok: true as const,
      reviewRevision: reviewRevision + 1,
      reviewCandidate,
    }),
  );
  render(
    <CaptureReview
      wines={[]}
      capture={captureFixture({
        reviewRevision: 2,
        reviewCandidate: {
          wine: { wineryName: "Estate", designation: "", grapeVarieties },
          bottle: { volumeMl: 1500 },
        },
      })}
      canWrite
      disabled={false}
      onDirtyChange={vi.fn<(dirty: boolean) => void>()}
      onBusyChange={vi.fn<(busy: boolean) => void>()}
      onImport={async () => ({ ok: true })}
      onSaveReview={onSaveReview}
    />,
  );
  expect(screen.getByRole("textbox", { name: "Grape variety 1" })).toHaveValue(grapeVarieties[0]);
  await user.type(screen.getByRole("textbox", { name: "Producer / winery" }), " corrected");
  await user.click(screen.getByRole("button", { name: "Save corrections" }));
  expect(onSaveReview).toHaveBeenCalledOnce();
  expect(onSaveReview.mock.calls[0]?.slice(0, 2)).toEqual(["capture-1", 2]);
  expect(onSaveReview.mock.calls[0]?.[2].wine.grapeVarieties).toEqual(grapeVarieties);
  expect(onSaveReview.mock.calls[0]?.[2].bottle.volumeMl).toBe(1500);
});
