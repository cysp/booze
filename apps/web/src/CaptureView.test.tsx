import type { WineOption } from "../shared/wine-options.ts";
import { useState, type ReactElement } from "react";
import axe from "axe-core";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CaptureImportAction, CaptureReviewSaveAction } from "../shared/capture-import.ts";
import { CaptureArea, type CaptureSubmitResult } from "./CaptureView.tsx";
import {
  captureFixture,
  inventoryItemFixture,
  capturesFixture,
  locationsFixture,
  sitesFixture,
} from "./test/catalogue-fixtures.ts";
import type { CaptureFormState, CaptureResource, CaptureRunResource } from "./inventory-model.ts";

const captureForm = {
  location: "",
  position: "",
  quantity: "1",
  site: "Home cellar",
  siteId: "site-owner",
  storageLocationId: "",
} satisfies CaptureFormState;

const resolvedReview: CaptureReviewSaveAction = async (_id, revision, candidate) => ({
  ok: true,
  reviewRevision: revision + 1,
  reviewCandidate: candidate,
});

const resolvedImport: CaptureImportAction = async () => ({ ok: true });

async function resolvedTrue(): Promise<boolean> {
  return true;
}

async function resolvedCapture(): Promise<CaptureSubmitResult> {
  return { kind: "submitted", message: "Capture submitted." };
}

function captureElement({
  captures = capturesFixture,
  wines = [],
  onDelete = resolvedTrue,
  onImport = resolvedImport,
  onSaveReview = resolvedReview,
  onRetry = resolvedTrue,
  onSubmit = resolvedCapture,
  onCancelAddition,
}: {
  readonly captures?: readonly CaptureResource[];
  readonly wines?: readonly WineOption[];
  readonly onDelete?: (captureId: string) => Promise<boolean>;
  readonly onImport?: CaptureImportAction;
  readonly onSaveReview?: CaptureReviewSaveAction;
  readonly onRetry?: (captureId: string) => Promise<boolean>;
  readonly onSubmit?: (
    form: CaptureFormState,
    files: readonly File[],
  ) => Promise<CaptureSubmitResult>;
  readonly onCancelAddition?: (siteId: string) => void;
} = {}) {
  return (
    <CaptureArea
      captures={captures}
      wines={wines}
      form={captureForm}
      isSaving={false}
      locations={locationsFixture}
      sites={sitesFixture}
      writableSiteIds={new Set(["site-owner", "site-editor"])}
      onDelete={onDelete}
      onImport={onImport}
      onSaveReview={onSaveReview}
      onRetry={onRetry}
      onSubmit={onSubmit}
      {...(onCancelAddition === undefined ? {} : { onCancelAddition })}
      setForm={vi.fn((nextForm: CaptureFormState): void => {
        void nextForm;
      })}
    />
  );
}

function renderCapture(options: Parameters<typeof captureElement>[0] = {}) {
  return render(captureElement(options));
}

const incompleteRun = {
  id: "run-rikard",
  status: "needs_review",
  extractionR2Key: null,
  extractionContentType: null,
  extractionSizeBytes: null,
  importCandidate: {
    wine: {
      wineryName: "RIKARD Wines",
      designation: "",
      displayName: "",
      vintageYear: 2022,
      grapeVarieties: ["Shiraz"],
    },
    bottle: { volumeMl: 750 },
    rawSuggestion: {},
  },
  matchResult: { wineVintageCandidates: [{ id: "existing", label: "Existing Shiraz" }] },
  importResult: null,
  errorMessage: null,
  errorDetailR2Key: null,
  errorDetailContentType: null,
  errorDetailSizeBytes: null,
  createdAt: "2026-09-22T00:00:00Z",
  completedAt: null,
} satisfies CaptureRunResource;

it("shows actionable import errors on the affected capture", async () => {
  const user = userEvent.setup();
  const message =
    "Capture processing changed before import. Refresh the capture before trying again.";
  const onImport = vi.fn<CaptureImportAction>(async () => ({ ok: false, message }));
  renderCapture({ captures: [captureFixture({ latestRun: incompleteRun })], onImport });
  await user.click(screen.getByRole("button", { name: "Create new" }));
  expect(onImport).toHaveBeenCalledExactlyOnceWith("capture-1", undefined, {
    expectedReviewRevision: 0,
  });
  expect(await screen.findByText(message)).toBeVisible();
});

it("passes an existing wine selection through the import action", async () => {
  const user = userEvent.setup();
  const onImport = vi.fn<CaptureImportAction>(resolvedImport);
  renderCapture({ captures: [captureFixture({ latestRun: incompleteRun })], onImport });
  await user.click(screen.getByRole("button", { name: "Use Existing Shiraz" }));
  expect(onImport).toHaveBeenCalledExactlyOnceWith("capture-1", "existing", {
    expectedReviewRevision: 0,
  });
});

function photo(name: string): File {
  return new File([name], name, { lastModified: 1, type: "image/jpeg" });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CaptureArea photo picker", () => {
  it("opens retained original photos for checking label evidence", () => {
    renderCapture({
      captures: [
        captureFixture({
          images: [
            {
              imageAssetId: "image-1",
              originalFilename: "front.jpg",
              sortOrder: 0,
              contentType: "image/jpeg",
              sizeBytes: 1024,
              imageUrl: "/api/bottle-captures/capture-1/images/image-1",
            },
          ],
        }),
      ],
    });
    expect(screen.getByRole("link", { name: "Open original photo front.jpg" })).toHaveAttribute(
      "href",
      "/api/bottle-captures/capture-1/images/image-1?original=1",
    );
  });

  it("accumulates sequential selections and gives explicit cap feedback", async () => {
    const user = userEvent.setup();
    renderCapture();
    const input = screen.getByLabelText(/Bottle photos/u);

    await user.upload(input, photo("front.jpg"));
    await user.upload(input, photo("back.jpg"));
    const description = screen.getByText((_content, element) => {
      return element?.id === "capture-bottle-photos-description";
    });
    expect(description).toHaveTextContent("2 of 4 selected.");

    await user.upload(input, [photo("side.jpg"), photo("detail.jpg"), photo("extra.jpg")]);
    expect(description).toHaveTextContent("4 of 4 selected.");
    expect(
      screen.getByText("Only 4 photos can be attached. 1 extra file was not added."),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Only 4 photos can be attached. 1 extra file was not added.",
    );
    expect(screen.getByRole("button", { name: "Add more bottle photos" })).toBeDisabled();
  });

  it("silently ignores a duplicate without claiming a cap rejection", async () => {
    const user = userEvent.setup();
    renderCapture();
    const input = screen.getByLabelText(/Bottle photos/u);

    await user.upload(input, photo("front.jpg"));
    await user.upload(input, photo("front.jpg"));

    expect(screen.getByText(/1 of 4 selected/u)).toBeInTheDocument();
    expect(screen.queryByText(/extra file/u)).not.toBeInTheDocument();
  });

  it("removes a selected photo and releases its preview URL", async () => {
    const user = userEvent.setup();
    const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL");
    renderCapture();
    const input = screen.getByLabelText(/Bottle photos/u);

    await user.upload(input, [photo("front.jpg"), photo("back.jpg")]);
    await user.click(
      screen.getByRole("button", {
        name: "Remove front.jpg — Preview of front.jpg",
      }),
    );

    expect(screen.queryByText("front.jpg")).not.toBeInTheDocument();
    expect(screen.getAllByText("back.jpg")).not.toHaveLength(0);
    expect(screen.getByText(/1 of 4 selected/u)).toBeInTheDocument();
    expect(revokeObjectUrl).toHaveBeenCalledTimes(1);
  });

  it("releases every remaining preview URL when capture unmounts", async () => {
    const user = userEvent.setup();
    const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL");
    const { unmount } = renderCapture();

    await user.upload(screen.getByLabelText(/Bottle photos/u), [
      photo("front.jpg"),
      photo("back.jpg"),
    ]);
    revokeObjectUrl.mockClear();
    unmount();

    expect(revokeObjectUrl).toHaveBeenCalledTimes(2);
  });

  it("has no automated accessibility violations", async () => {
    const { container } = renderCapture();
    const result = await axe.run(container, {
      rules: { "color-contrast": { enabled: false } },
    });

    expect(result.violations).toEqual([]);
  });

  it("confirms deletion, blocks repeat activation, and keeps local failure feedback", async () => {
    const user = userEvent.setup();
    let resolveDelete: ((deleted: boolean) => void) | undefined;
    const onDelete = vi.fn(
      async () =>
        new Promise<boolean>((resolve) => {
          resolveDelete = resolve;
        }),
    );
    renderCapture({ onDelete });

    const deleteTriggers = screen.getAllByRole("button", { name: "Delete capture" });
    const deleteTrigger = deleteTriggers.at(-1);
    if (deleteTrigger === undefined) {
      throw new Error("Expected a deletable capture fixture.");
    }
    await user.click(deleteTrigger);
    expect(onDelete).not.toHaveBeenCalled();

    const dialog = screen.getByRole("alertdialog", { name: "Delete this capture?" });
    const deleteAction = within(dialog).getByRole("button", { name: "Delete capture" });
    await user.click(deleteAction);
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(deleteAction).toHaveAttribute("aria-busy", "true");
    expect(deleteAction).toHaveAttribute("aria-disabled", "true");
    await user.click(deleteAction);
    await user.keyboard("{Enter} ");
    expect(onDelete).toHaveBeenCalledTimes(1);

    resolveDelete?.(false);
    expect(await screen.findByText("Delete failed. Try again.")).toBeVisible();
    expect(dialog).toBeVisible();
    await waitFor(() => {
      expect(deleteAction).not.toHaveAttribute("aria-busy", "true");
      expect(deleteAction).not.toHaveAttribute("aria-disabled", "true");
    });
  });
});

function QuantityCaptureHarness({
  onSubmit,
}: {
  readonly onSubmit: (
    form: CaptureFormState,
    files: readonly File[],
  ) => Promise<CaptureSubmitResult>;
}): ReactElement {
  const [form, setForm] = useState<CaptureFormState>(captureForm);
  return (
    <CaptureArea
      captures={[]}
      form={form}
      setForm={setForm}
      isSaving={false}
      locations={locationsFixture}
      sites={sitesFixture}
      writableSiteIds={new Set(["site-owner"])}
      onDelete={resolvedTrue}
      onImport={resolvedImport}
      onSaveReview={resolvedReview}
      onRetry={resolvedTrue}
      onSubmit={onSubmit}
    />
  );
}

it("preserves invalid capture quantity drafts and submits corrected full-width digits", async () => {
  const user = userEvent.setup();
  const onSubmit = vi.fn(resolvedCapture);
  render(<QuantityCaptureHarness onSubmit={onSubmit} />);
  await user.upload(screen.getByLabelText(/Bottle photos/u), photo("label.jpg"));
  const input = screen.getByRole("textbox", { name: /quantity/iu });
  expect(input).toHaveAttribute("inputmode", "numeric");
  for (const draft of ["25", "1.5", "", "2 bottles"]) {
    await user.clear(input);
    if (draft !== "") await user.type(input, draft);
    await user.click(screen.getByRole("button", { name: "Submit capture" }));
    expect(input).toHaveValue(draft);
    expect(onSubmit).not.toHaveBeenCalled();
  }
  await user.clear(input);
  await user.paste("１２");
  await user.click(screen.getByRole("button", { name: "Submit capture" }));
  expect(input).toHaveValue("１２");
  expect(onSubmit).toHaveBeenCalledWith(
    expect.objectContaining({ quantity: "１２" }),
    expect.any(Array),
  );
});

it("saves manual corrections separately and requires an explicit revision-aware import", async () => {
  const user = userEvent.setup();
  const onSaveReview = vi.fn<CaptureReviewSaveAction>(resolvedReview);
  const onImport = vi.fn<CaptureImportAction>(resolvedImport);
  renderCapture({
    captures: [captureFixture({ latestRun: incompleteRun })],
    onSaveReview,
    onImport,
  });
  await user.clear(screen.getByRole("textbox", { name: "Producer / winery" }));
  await user.type(screen.getByRole("textbox", { name: "Producer / winery" }), "RIKARD");
  expect(screen.getByRole("button", { name: "Create new" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Retry" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Save corrections" }));
  expect(onSaveReview).toHaveBeenCalledOnce();
  expect(onSaveReview.mock.calls[0]?.slice(0, 2)).toEqual(["capture-1", 0]);
  expect(onSaveReview.mock.calls[0]?.[2].wine).toMatchObject({
    wineryName: "RIKARD",
    designation: "",
    vintageYear: 2022,
    vintageStatus: "year",
    grapeVarieties: ["Shiraz"],
  });
  expect(onImport).not.toHaveBeenCalled();
  await user.click(screen.getByText("Original extracted facts"));
  expect(screen.getByText("RIKARD Wines")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Create new" }));
  expect(onImport).toHaveBeenCalledExactlyOnceWith("capture-1", undefined, {
    expectedReviewRevision: 1,
  });
});

it("retains cleared values and edits when saving corrections fails", async () => {
  const user = userEvent.setup();
  const onSaveReview = vi.fn<CaptureReviewSaveAction>(async () => ({
    ok: false,
    message: "Another editor changed this capture. Refresh before saving.",
  }));
  renderCapture({ captures: [captureFixture({ latestRun: incompleteRun })], onSaveReview });
  await user.clear(screen.getByRole("textbox", { name: "Bottle size (ml)" }));
  await user.type(screen.getByRole("textbox", { name: "Bottle notes" }), "Check cork");
  await user.click(screen.getByRole("button", { name: "Save corrections" }));
  expect(onSaveReview.mock.calls[0]?.[2].bottle).not.toHaveProperty("volumeMl");
  expect(screen.getByRole("textbox", { name: "Bottle notes" })).toHaveValue("Check cork");
  expect(screen.getByRole("textbox", { name: "Bottle size (ml)" })).toHaveValue("");
  expect(
    screen.getByText("Another editor changed this capture. Refresh before saving."),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Create new" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Retry" })).toBeDisabled();
});

it("requires saving an empty manual review before explicit unidentified import", async () => {
  const user = userEvent.setup();
  const onSaveReview = vi.fn<CaptureReviewSaveAction>(resolvedReview);
  const onImport = vi.fn<CaptureImportAction>(resolvedImport);
  renderCapture({
    captures: [captureFixture({ status: "failed", latestRun: null })],
    onSaveReview,
    onImport,
  });
  expect(screen.getByRole("button", { name: "Save as unidentified wine" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Save corrections" }));
  expect(onImport).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Save as unidentified wine" }));
  expect(onImport).toHaveBeenCalledExactlyOnceWith("capture-1", undefined, {
    expectedReviewRevision: 1,
    allowUnidentified: true,
  });
});

it.each([
  { label: "without extraction", latestRun: null },
  { label: "after corrections", latestRun: incompleteRun },
])("selects an existing site wine explicitly $label", async ({ latestRun }) => {
  const user = userEvent.setup();
  const onImport = vi.fn<CaptureImportAction>(resolvedImport);
  const duplicateTitle = {
    displayName: "Same Chardonnay",
    wineryName: "Producer",
    grapeVarieties: "Chardonnay",
  };
  const first = inventoryItemFixture({ ...duplicateTitle, wineVintageId: "first-wine" });
  const second = inventoryItemFixture({
    ...duplicateTitle,
    bottleId: "second-bottle",
    wineVintageId: "second-wine",
  });
  const otherSite = inventoryItemFixture({
    siteId: "site-editor",
    wineVintageId: "other-site-wine",
    displayName: "Other site wine",
  });
  renderCapture({
    captures: [
      captureFixture({
        latestRun,
        reviewRevision: 2,
        reviewCandidate: {
          wine: {
            wineryName: "Corrected producer",
            designation: "",
            grapeVarieties: ["Chardonnay"],
          },
          bottle: {},
        },
      }),
    ],
    wines: [first, second, otherSite].map((item) => ({
      ...item,
      grapeVarieties: item.grapeVarieties?.split(",") ?? [],
    })),
    onImport,
  });
  expect(screen.queryByRole("button", { name: "Use Existing Shiraz" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Use selected wine" })).toBeDisabled();
  await user.click(screen.getByRole("combobox", { name: "Existing wine in this site" }));
  expect(screen.getByRole("option", { name: /first-wine/u })).toBeVisible();
  expect(screen.queryByRole("option", { name: /Other site wine/u })).not.toBeInTheDocument();
  await user.click(screen.getByRole("option", { name: /second-wine/u }));
  expect(onImport).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Use selected wine" }));
  expect(onImport).toHaveBeenCalledExactlyOnceWith("capture-1", "second-wine", {
    expectedReviewRevision: 2,
  });
});

it.each([0, 1])(
  "retains unsaved corrections through another editor's retry at revision %i",
  async (reviewRevision) => {
    const user = userEvent.setup();
    const capture = captureFixture({
      status: "failed",
      reviewRevision,
      reviewCandidate:
        reviewRevision === 0
          ? null
          : {
              wine: { wineryName: "Saved producer", designation: "", grapeVarieties: ["Shiraz"] },
              bottle: {},
            },
    });
    const { rerender } = renderCapture({ captures: [capture] });
    const producer = screen.getByRole("textbox", { name: "Producer / winery" });
    await user.clear(producer);
    await user.type(producer, "My unsaved correction");
    rerender(captureElement({ captures: [{ ...capture, status: "extracting" }] }));
    expect(screen.getByRole("textbox", { name: "Producer / winery" })).toHaveValue(
      "My unsaved correction",
    );
    expect(producer).toHaveAttribute("aria-disabled", "true");
    expect(producer).toHaveAttribute("readonly");
    await user.type(producer, "unavailable edit");
    expect(producer).toHaveValue("My unsaved correction");
    expect(screen.getByRole("button", { name: "Save corrections" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Create new" })).toBeDisabled();
    rerender(
      captureElement({
        captures: [{ ...capture, status: "needs_review", latestRun: incompleteRun }],
      }),
    );
    expect(screen.getByRole("textbox", { name: "Producer / winery" })).toHaveValue(
      "My unsaved correction",
    );
    await user.click(screen.getByRole("button", { name: "Save corrections" }));
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
  },
);

it("can reuse a depleted wine after saving capture corrections", async () => {
  const user = userEvent.setup();
  const onImport = vi.fn<CaptureImportAction>(resolvedImport);
  const depletedWine: WineOption = {
    wineVintageId: "depleted-wine",
    siteId: "site-owner",
    displayName: "Rikard Shiraz",
    wineryName: "Rikard",
    grapeVarieties: ["Shiraz"],
    vintageYear: 2022,
    vintageStatus: "year",
    vintageLabel: "2022",
    region: null,
  };
  renderCapture({
    captures: [captureFixture({ latestRun: incompleteRun })],
    wines: [depletedWine],
    onImport,
  });
  await user.type(screen.getByRole("textbox", { name: "Bottle notes" }), "Manual bottle note");
  await user.click(screen.getByRole("button", { name: "Save corrections" }));
  await user.click(screen.getByRole("combobox", { name: "Existing wine in this site" }));
  await user.click(screen.getByRole("option", { name: /depleted-wine/u }));
  await user.click(screen.getByRole("button", { name: "Use selected wine" }));
  expect(onImport).toHaveBeenCalledExactlyOnceWith("capture-1", "depleted-wine", {
    expectedReviewRevision: 1,
  });
});

it("retains a local draft for reference when another editor imports the capture", async () => {
  const user = userEvent.setup();
  const capture = captureFixture({ latestRun: incompleteRun });
  const { rerender } = renderCapture({ captures: [capture] });
  await user.type(
    screen.getByRole("textbox", { name: "Bottle notes" }),
    "Unsubmitted bottle correction",
  );
  rerender(captureElement({ captures: [{ ...capture, status: "imported" }] }));
  expect(screen.getByRole("textbox", { name: "Bottle notes" })).toHaveValue(
    "Unsubmitted bottle correction",
  );
  const notes = screen.getByRole("textbox", { name: "Bottle notes" });
  expect(notes).toHaveAttribute("aria-disabled", "true");
  expect(notes).toHaveAttribute("readonly");
  await user.type(notes, "unavailable edit");
  expect(notes).toHaveValue("Unsubmitted bottle correction");
  expect(screen.getByText(/was imported elsewhere/u)).toBeVisible();
  expect(screen.getByRole("button", { name: "Save corrections" })).toBeDisabled();
});

it("keeps a dirty capture mounted when a new upload pushes it beyond the visible page", async () => {
  const user = userEvent.setup();
  const captures = Array.from({ length: 50 }, (_, index) =>
    captureFixture({ id: `capture-${index}`, status: index === 49 ? "needs_review" : "queued" }),
  );
  const { rerender } = renderCapture({ captures });
  await user.type(screen.getByRole("textbox", { name: "Bottle notes" }), "Keep this draft");
  rerender(
    captureElement({
      captures: [captureFixture({ id: "new-capture", status: "queued" }), ...captures],
    }),
  );
  expect(screen.getByRole("textbox", { name: "Bottle notes" })).toHaveValue("Keep this draft");
  expect(screen.getByText("Showing all 51 captures")).toBeVisible();
  const newer = Array.from({ length: 101 }, (_, index) =>
    captureFixture({ id: `new-${index}`, status: "queued" }),
  );
  rerender(captureElement({ captures: [...newer, ...captures] }));
  expect(screen.getByText("Showing 51 of 151 captures")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Show 50 more" }));
  expect(screen.getByText("Showing 101 of 151 captures")).toBeVisible();
  expect(screen.getByRole("textbox", { name: "Bottle notes" })).toHaveValue("Keep this draft");
});

it("retains incomplete submission photos and exposes deliberate start-another intent for the current site", async () => {
  const user = userEvent.setup();
  const onCancelAddition = vi.fn<(siteId: string) => void>();
  const onSubmit = vi.fn(async (): Promise<CaptureSubmitResult> => ({
    kind: "pending",
    message: "Capture saved; image upload is incomplete.",
  }));
  renderCapture({ onSubmit, onCancelAddition });
  await user.upload(screen.getByLabelText(/Bottle photos/u), photo("label.jpg"));
  await user.click(screen.getByRole("button", { name: "Submit capture" }));
  expect(screen.getByText(/1 of 4 selected/u)).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Start another capture" }));
  expect(onCancelAddition).toHaveBeenCalledExactlyOnceWith("site-owner");
  expect(screen.getByText(/1 of 4 selected/u)).toBeVisible();
});
