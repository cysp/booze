import { render, screen, within } from "@testing-library/react";
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
  expect(screen.getByRole("button", { name: "Add bottles as new wine" })).toBeDisabled();
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

function reviewWithIssue(path: string, rawValue: string): CaptureRunResource {
  return {
    ...run,
    importCandidate: {
      wine: { wineryName: "Rowlee", grapeVarieties: ["Shiraz"], vintageStatus: "unknown" },
      bottle: {},
      validationIssues: [{ path, rawValue, message: "Check this value against the photos." }],
    },
  };
}

function reviewActions() {
  return {
    wines: [],
    canWrite: true,
    disabled: false,
    onDirtyChange: vi.fn<(dirty: boolean) => void>(),
    onBusyChange: vi.fn<(busy: boolean) => void>(),
    onImport: vi.fn(async () => ({ ok: true as const })),
    onSaveReview: vi.fn(
      async (_id: string, reviewRevision: number, reviewCandidate: CaptureReviewCandidate) => ({
        ok: true as const,
        reviewRevision: reviewRevision + 1,
        reviewCandidate,
      }),
    ),
  };
}

it("labels an unknown physical size as a default and requires human confirmation even for confident extraction", async () => {
  const user = userEvent.setup();
  const actions = reviewActions();
  render(
    <CaptureReview
      {...actions}
      capture={captureFixture({
        quantity: 3,
        latestRun: {
          ...run,
          importCandidate: {
            wine: { wineryName: "Rowlee", grapeVarieties: ["Shiraz"] },
            bottle: {},
            confidence: 1,
          },
        },
      })}
    />,
  );
  expect(screen.getByText(/confirm adding 3 bottles to inventory/u)).toBeVisible();
  expect(screen.getByText(/750 mL by default/u)).toBeVisible();
  expect(screen.getByRole("textbox", { name: "Bottle size (ml)" })).toHaveValue("");
  await user.click(screen.getByText("Original extracted facts"));
  expect(screen.queryByText("750", { selector: "dd" })).not.toBeInTheDocument();
  expect(actions.onImport).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Add bottles as new wine" }));
  expect(actions.onImport).toHaveBeenCalledExactlyOnceWith("capture-1", undefined, {
    expectedReviewRevision: 0,
  });
});

it("keeps invalid raw bottle size visible and blocks unrelated saves and stock confirmation", async () => {
  const user = userEvent.setup();
  const actions = reviewActions();
  render(
    <CaptureReview
      {...actions}
      capture={captureFixture({ latestRun: reviewWithIssue("bottle.volumeMl", "750 mL extra") })}
    />,
  );
  expect(screen.getByRole("textbox", { name: "Bottle size (ml)" })).toHaveValue("750 mL extra");
  expect(screen.queryByText(/750 mL by default/u)).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Add bottles as new wine" })).toBeDisabled();
  await user.type(screen.getByRole("textbox", { name: "Bottle notes" }), "Check cork");
  await user.click(screen.getByRole("button", { name: "Save corrections" }));
  expect(screen.getByText("Bottle size (ml) must be a finite number.")).toBeVisible();
  expect(actions.onSaveReview).not.toHaveBeenCalled();
  expect(actions.onImport).not.toHaveBeenCalled();
});

it.each(["", "0", "30001", "750.5"])(
  "requires a schema-valid physical size instead of clearing the original invalid value to %j",
  async (volume) => {
    const user = userEvent.setup();
    const actions = reviewActions();
    render(
      <CaptureReview
        {...actions}
        capture={captureFixture({ latestRun: reviewWithIssue("bottle.volumeMl", "750 mL extra") })}
      />,
    );
    await user.clear(screen.getByRole("textbox", { name: "Bottle size (ml)" }));
    if (volume !== "")
      await user.type(screen.getByRole("textbox", { name: "Bottle size (ml)" }), volume);
    await user.click(screen.getByRole("button", { name: "Save corrections" }));
    expect(actions.onSaveReview).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Add bottles as new wine" })).toBeDisabled();
    expect(screen.queryByText(/750 mL by default/u)).not.toBeInTheDocument();
  },
);

it("saves the corrected physical size before explicitly confirming stock with its revision", async () => {
  const user = userEvent.setup();
  const actions = reviewActions();
  render(
    <CaptureReview
      {...actions}
      capture={captureFixture({ latestRun: reviewWithIssue("bottle.volumeMl", "750 mL extra") })}
    />,
  );
  await user.clear(screen.getByRole("textbox", { name: "Bottle size (ml)" }));
  await user.type(screen.getByRole("textbox", { name: "Bottle size (ml)" }), "1500");
  await user.click(screen.getByRole("button", { name: "Save corrections" }));
  expect(actions.onSaveReview.mock.calls[0]?.[2].bottle.volumeMl).toBe(1500);
  expect(actions.onImport).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Add bottles as new wine" }));
  expect(actions.onImport).toHaveBeenCalledExactlyOnceWith("capture-1", undefined, {
    expectedReviewRevision: 1,
  });
});

it("does not acknowledge a parsable raw size through an unrelated edit, but accepts deliberate re-entry", async () => {
  const user = userEvent.setup();
  const actions = reviewActions();
  render(
    <CaptureReview
      {...actions}
      capture={captureFixture({ latestRun: reviewWithIssue("bottle.volumeMl", "750") })}
    />,
  );
  await user.type(screen.getByRole("textbox", { name: "Bottle notes" }), "Check cork");
  await user.click(screen.getByRole("button", { name: "Save corrections" }));
  expect(actions.onSaveReview).not.toHaveBeenCalled();
  expect(screen.getByRole("textbox", { name: "Bottle size (ml)" })).toHaveValue("750");
  await user.clear(screen.getByRole("textbox", { name: "Bottle size (ml)" }));
  await user.type(screen.getByRole("textbox", { name: "Bottle size (ml)" }), "750");
  await user.click(screen.getByRole("button", { name: "Save corrections" }));
  expect(actions.onSaveReview.mock.calls[0]?.[2].bottle.volumeMl).toBe(750);
});

it.each([
  { path: "wine.alcoholPercent", rawValue: "about 14%", blocked: false },
  { path: "bottle.volumeMl", rawValue: "750 mL extra", blocked: true },
])(
  "keeps an existing wine's facts while protecting physical issues at $path",
  async ({ path, rawValue, blocked }) => {
    const user = userEvent.setup();
    const actions = reviewActions();
    render(
      <CaptureReview
        {...actions}
        capture={captureFixture({
          latestRun: {
            ...reviewWithIssue(path, rawValue),
            matchResult: { wineVintageCandidates: [{ id: "existing", label: "Existing Rowlee" }] },
          },
        })}
      />,
    );
    const add = screen.getByRole("button", { name: "Add bottles to Existing Rowlee" });
    if (blocked) {
      expect(add).toBeDisabled();
      expect(screen.getByRole("combobox", { name: "Existing wine in this site" })).toHaveAttribute(
        "aria-disabled",
        "true",
      );
      expect(actions.onImport).not.toHaveBeenCalled();
    } else {
      expect(add).toBeEnabled();
      expect(actions.onImport).not.toHaveBeenCalled();
      await user.click(add);
      expect(actions.onImport).toHaveBeenCalledExactlyOnceWith("capture-1", "existing", {
        expectedReviewRevision: 0,
      });
    }
  },
);

it("requires deliberate clearing of invalid ABV and retains the unknown value after refresh", async () => {
  const user = userEvent.setup();
  const actions = reviewActions();
  const latestRun = reviewWithIssue("wine.alcoholPercent", "about 14%");
  const { rerender } = render(
    <CaptureReview {...actions} capture={captureFixture({ latestRun })} />,
  );
  expect(screen.getByRole("textbox", { name: "Alcohol (%)" })).toHaveValue("about 14%");
  await user.type(
    screen.getByRole("textbox", { name: "Wine notes and extraction disagreements" }),
    "Back label unclear",
  );
  await user.click(screen.getByRole("button", { name: "Save corrections" }));
  expect(actions.onSaveReview).not.toHaveBeenCalled();
  await user.clear(screen.getByRole("textbox", { name: "Alcohol (%)" }));
  await user.click(screen.getByRole("button", { name: "Save corrections" }));
  const saved = actions.onSaveReview.mock.calls[0]?.[2];
  expect(saved?.wine.alcoholPercent).toBeNull();
  expect(screen.getByRole("textbox", { name: "Alcohol (%)" })).toHaveValue("");
  rerender(
    <CaptureReview
      {...actions}
      capture={captureFixture({ latestRun, reviewCandidate: saved ?? null, reviewRevision: 1 })}
    />,
  );
  expect(screen.getByRole("textbox", { name: "Alcohol (%)" })).toHaveValue("");
  await user.click(screen.getByText("Original extracted facts"));
  expect(
    within(screen.getByRole("list", { name: "Original extraction issues" })).getByText(
      /about 14%/u,
    ),
  ).toBeVisible();
});

it("requires an invalid vintage to be corrected or explicitly acknowledged as unknown", async () => {
  const user = userEvent.setup();
  const actions = reviewActions();
  render(
    <CaptureReview
      {...actions}
      capture={captureFixture({ latestRun: reviewWithIssue("wine.vintageYear", "202?") })}
    />,
  );
  expect(screen.getByRole("textbox", { name: "Vintage year" })).toHaveValue("202?");
  expect(screen.getByRole("textbox", { name: "Vintage year" })).toBeEnabled();
  await user.click(screen.getByRole("combobox", { name: "Vintage status" }));
  await user.click(screen.getByRole("option", { name: "Unknown" }));
  await user.click(screen.getByRole("button", { name: "Save corrections" }));
  expect(actions.onSaveReview.mock.calls[0]?.[2].wine).toMatchObject({
    vintageStatus: "unknown",
    vintageYear: null,
  });
  expect(screen.getByRole("textbox", { name: "Vintage year" })).toHaveValue("");
});
