/* oxlint-disable import/max-dependencies -- Capture composes the ASTRYX upload, status, disclosure, and confirmation surfaces. */
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Link } from "@astryxdesign/core/Link";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Thumbnail } from "@astryxdesign/core/Thumbnail";
import { useEffect, useRef, useState, type MouseEvent, type ReactElement } from "react";

import type {
  CaptureImportAction,
  CaptureImportResult,
  CaptureReviewSaveAction,
} from "../shared/capture-import.ts";
import { formatWineLabel } from "../shared/wine-identity.ts";
import { validateBottleQuantity } from "../shared/quantity.ts";
import { QuantityInput } from "./QuantityInput.tsx";
import type {
  CaptureFormState,
  CaptureImageResource,
  CaptureResource,
  LocationItem,
  SiteItem,
} from "./inventory-model.ts";
import { storageLocationLabel } from "./inventory-model.ts";
import { BottleLocationPicker } from "./BottleLocationPicker.tsx";
import { DestructiveActionDialog } from "./DestructiveActionDialog.tsx";
import { ProgressiveListStatus, PROGRESSIVE_PAGE_SIZE } from "./ProgressiveListStatus.tsx";
import { MAX_CAPTURE_FILES, mergeCaptureFiles } from "./capture-files.ts";
import { captureStatus } from "./capture-status.ts";
import type { WineOption } from "../shared/wine-options.ts";
import { CaptureReview } from "./CaptureReview.tsx";

type CaptureAreaProps = {
  readonly captures: readonly CaptureResource[];
  readonly wines?: readonly WineOption[];
  readonly form: CaptureFormState;
  readonly isSaving: boolean;
  readonly locations: readonly LocationItem[];
  readonly sites: readonly SiteItem[];
  readonly writableSiteIds: ReadonlySet<string>;
  readonly setForm: (form: CaptureFormState) => void;
  readonly onCancelAddition?: (siteId: string) => void;
  readonly onDelete: (captureId: string) => Promise<boolean>;
  readonly onImport: CaptureImportAction;
  readonly onSaveReview: CaptureReviewSaveAction;
  readonly onRetry: (captureId: string) => Promise<boolean>;
  readonly onSubmit: (
    form: CaptureFormState,
    files: readonly File[],
  ) => Promise<CaptureSubmitResult>;
};

export type CaptureSubmitResult =
  | { readonly kind: "pending"; readonly message: string }
  | {
      readonly kind: "submitted";
      readonly message: string;
    }
  | {
      readonly kind: "saved_with_error";
      readonly message: string;
    }
  | {
      readonly kind: "failed";
      readonly message: string;
    };

export function CaptureArea({
  captures,
  wines = [],
  form,
  isSaving,
  locations,
  sites,
  writableSiteIds,
  setForm,
  onDelete,
  onCancelAddition,
  onImport,
  onSaveReview,
  onRetry,
  onSubmit,
}: CaptureAreaProps): ReactElement {
  const [files, setFiles] = useState<readonly File[]>([]);
  const [fileSelectionMessage, setFileSelectionMessage] = useState<string | null>(null);
  const [isQuantityTouched, setIsQuantityTouched] = useState(false);
  const [submitResult, setSubmitResult] = useState<CaptureSubmitResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const quantityValidation = validateBottleQuantity(form.quantity);

  useEffect(() => {
    if (form.siteId !== "" || sites.length === 0) {
      return;
    }
    const site = sites[0];
    if (site === undefined) {
      return;
    }
    setForm({
      ...form,
      siteId: site.id,
      site: site.name,
      storageLocationId: "",
      location: "",
    });
  }, [form, setForm, sites]);

  async function submitCapture(): Promise<void> {
    setSubmitResult(null);
    const quantity = validateBottleQuantity(form.quantity);
    if (!quantity.ok) {
      setIsQuantityTouched(true);
      setSubmitResult({ kind: "failed", message: quantity.message });
      return;
    }
    const result = await onSubmit(form, files);
    setSubmitResult(result);
    if (result.kind === "submitted" || result.kind === "saved_with_error") {
      setFiles([]);
    }
  }

  return (
    <section className="workspace" aria-labelledby="capture-title">
      <div className="workspace-header">
        <div>
          <p>Capture</p>
          <h2 id="capture-title">Photograph bottles</h2>
        </div>
      </div>

      {writableSiteIds.size === 0 ? (
        <p className="field-hint">You have read-only access to these captures.</p>
      ) : (
        <form
          className="capture-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submitCapture();
          }}
        >
          <div className="form-section">
            <h3>Location</h3>
            <BottleLocationPicker
              idPrefix="capture-storage"
              locations={locations}
              selectedSiteId={form.siteId}
              selectedStorageLocationId={form.storageLocationId}
              sites={sites}
              onChange={(selection) => {
                setForm({
                  ...form,
                  siteId: selection.siteId,
                  site: selection.site,
                  storageLocationId: selection.storageLocationId,
                  location: selection.location,
                  position: selection.storageLocationId === "" ? "" : form.position,
                });
              }}
            />
            <div className="field-row">
              <TextInput
                autoComplete="off"
                htmlName="capturePosition"
                isDisabled={form.storageLocationId === ""}
                {...(form.storageLocationId === ""
                  ? { description: "Choose a location to add a position note." }
                  : {})}
                label="Position note"
                placeholder="Row 3, slot 2"
                value={form.position}
                onChange={(value: string) => {
                  setForm({ ...form, position: value });
                }}
              />
              <QuantityInput
                status={
                  isQuantityTouched && !quantityValidation.ok
                    ? { message: quantityValidation.message, type: "error" }
                    : undefined
                }
                value={form.quantity}
                onBlur={() => {
                  setIsQuantityTouched(true);
                }}
                onChange={(quantity) => {
                  setForm({ ...form, quantity });
                }}
              />
            </div>
          </div>

          <div className="form-section">
            <h3>Images</h3>
            <div className="capture-file-control">
              <div>
                <label htmlFor="capture-bottle-photos">
                  Bottle photos <span>Required</span>
                </label>
                <p id="capture-bottle-photos-description">
                  Add up to four clear label and bottle photos. {files.length} of{" "}
                  {MAX_CAPTURE_FILES} selected.
                </p>
              </div>
              <Button
                isDisabled={files.length >= MAX_CAPTURE_FILES}
                label={files.length === 0 ? "Choose bottle photos" : "Add more bottle photos"}
                onClick={() => {
                  fileInputRef.current?.click();
                }}
              />
              {/* ASTRYX FileInput 0.1.8 nests its native input inside role="button"
                  and forwards aria-required to that role. Keep this input as a
                  sibling of the ASTRYX trigger until upstream semantics are revalidated. */}
              <input
                ref={fileInputRef}
                accept="image/*,.heic,.heif"
                aria-describedby="capture-bottle-photos-description"
                className="capture-file-input"
                id="capture-bottle-photos"
                multiple
                tabIndex={-1}
                type="file"
                onChange={(event) => {
                  const selected = [...(event.currentTarget.files ?? [])];
                  const result = mergeCaptureFiles(files, selected);
                  setFileSelectionMessage(
                    result.rejectedCount === 0
                      ? null
                      : result.rejectedCount === 1
                        ? `Only ${MAX_CAPTURE_FILES} photos can be attached. 1 extra file was not added.`
                        : `Only ${MAX_CAPTURE_FILES} photos can be attached. ${result.rejectedCount} extra files were not added.`,
                  );
                  setFiles(result.files);
                  event.currentTarget.value = "";
                }}
              />
            </div>
            {fileSelectionMessage === null ? null : (
              <Banner role="alert" status="warning" title={fileSelectionMessage} />
            )}
            {files.length === 0 ? null : (
              <ul className="photo-list" aria-label="Selected bottle photos">
                {files.map((file, index) => (
                  <SelectedPhoto
                    file={file}
                    key={`${file.name}-${file.size}-${file.type}-${file.lastModified}`}
                    onRemove={() => {
                      setFiles(files.filter((_, fileIndex) => fileIndex !== index));
                    }}
                  />
                ))}
              </ul>
            )}
            <Button
              isDisabled={files.length === 0}
              isLoading={isSaving}
              label="Submit capture"
              type="submit"
              variant="primary"
            />
            {submitResult === null ||
            (submitResult.kind !== "pending" && submitResult.kind !== "failed") ||
            onCancelAddition === undefined ? null : (
              <Button
                label="Start another capture"
                isDisabled={isSaving}
                type="button"
                onClick={() => {
                  onCancelAddition(form.siteId);
                  setSubmitResult(null);
                }}
              />
            )}
            {/* Submission outcomes are already announced by the app's persistent status region. */}
            {submitResult === null ? null : (
              <Banner
                status={
                  submitResult.kind === "submitted"
                    ? "success"
                    : submitResult.kind === "failed"
                      ? "error"
                      : "warning"
                }
                title={submitResult.message}
              />
            )}
          </div>
        </form>
      )}

      <CaptureDashboard
        captures={captures}
        wines={wines}
        locations={locations}
        writableSiteIds={writableSiteIds}
        onDelete={onDelete}
        onImport={onImport}
        onSaveReview={onSaveReview}
        onRetry={onRetry}
      />
    </section>
  );
}

function SelectedPhoto({
  file,
  onRemove,
}: {
  readonly file: File;
  readonly onRemove: () => void;
}): ReactElement {
  const [previewUrl, setPreviewUrl] = useState("");

  useEffect(() => {
    const objectUrl = URL.createObjectURL(file);
    setPreviewUrl(objectUrl);
    return () => {
      URL.revokeObjectURL(objectUrl);
    };
  }, [file]);

  return (
    <li>
      {previewUrl === "" ? null : (
        <Thumbnail
          alt={`Preview of ${file.name}`}
          label={file.name}
          src={previewUrl}
          onRemove={onRemove}
        />
      )}
      <span>{file.name}</span>
    </li>
  );
}

function CaptureDashboard({
  captures,
  wines,
  locations,
  writableSiteIds,
  onDelete,
  onImport,
  onSaveReview,
  onRetry,
}: {
  readonly captures: readonly CaptureResource[];
  readonly wines: readonly WineOption[];
  readonly locations: readonly LocationItem[];
  readonly writableSiteIds: ReadonlySet<string>;
  readonly onDelete: (captureId: string) => Promise<boolean>;
  readonly onImport: CaptureImportAction;
  readonly onSaveReview: CaptureReviewSaveAction;
  readonly onRetry: (captureId: string) => Promise<boolean>;
}): ReactElement {
  const [showAll, setShowAll] = useState(false);
  const [dirtyCaptureIds, setDirtyCaptureIds] = useState<ReadonlySet<string>>(new Set());
  const [deletingCapture, setDeletingCapture] = useState<CaptureResource | null>(null);
  const [visibleCount, setVisibleCount] = useState(PROGRESSIVE_PAGE_SIZE);
  const deleteTriggerRef = useRef<HTMLButtonElement>(null);
  const sectionHeadingRef = useRef<HTMLHeadingElement>(null);

  const actionableCaptures = captures.filter((capture) => isActionableCapture(capture));
  const displayedCaptures = showAll
    ? captures
    : captures.filter(
        (capture) => capture.status !== "imported" || dirtyCaptureIds.has(capture.id),
      );
  const visibleCaptures = displayedCaptures.filter(
    (capture, index) => index < visibleCount || dirtyCaptureIds.has(capture.id),
  );
  const hiddenCaptureCount = captures.filter((capture) => capture.status === "imported").length;
  const processingCaptureCount = captures.length - hiddenCaptureCount - actionableCaptures.length;

  return (
    <>
      <div className="capture-list-header">
        <div>
          <h3 ref={sectionHeadingRef} tabIndex={-1}>
            {showAll ? "All captures" : "Action needed"}
          </h3>
          <p>
            {actionableCaptures.length === 0
              ? "No captures need action."
              : `${actionableCaptures.length} capture${actionableCaptures.length === 1 ? "" : "s"} need action.`}
            {processingCaptureCount === 0
              ? null
              : ` ${processingCaptureCount} processing. Progress updates automatically.`}
          </p>
        </div>
        {hiddenCaptureCount === 0 ? null : (
          <Button
            label={showAll ? "Show action needed" : `Show all ${captures.length}`}
            variant="secondary"
            onClick={() => {
              setShowAll(!showAll);
              setVisibleCount(PROGRESSIVE_PAGE_SIZE);
            }}
          />
        )}
      </div>
      {captures.length === 0 ? (
        <EmptyState
          description="Submit bottle photos here and imported bottles will appear in inventory."
          title="No captures yet"
        />
      ) : displayedCaptures.length === 0 ? (
        <EmptyState
          description={`${hiddenCaptureCount} capture${hiddenCaptureCount === 1 ? " has" : "s have"} been imported.`}
          title="Nothing to action"
        />
      ) : (
        <div className="capture-list">
          {visibleCaptures.map((capture) => (
            <CaptureCard
              capture={capture}
              wines={wines}
              canWrite={writableSiteIds.has(capture.siteId)}
              key={capture.id}
              locations={locations}
              onImport={onImport}
              onSaveReview={onSaveReview}
              onRequestDelete={(target, trigger) => {
                deleteTriggerRef.current = trigger;
                setDeletingCapture(target);
              }}
              onReviewDirtyChange={(dirty) => {
                setDirtyCaptureIds((current) => {
                  const next = new Set(current);
                  if (dirty) next.add(capture.id);
                  else next.delete(capture.id);
                  return next;
                });
              }}
              onRetry={onRetry}
            />
          ))}
        </div>
      )}
      <ProgressiveListStatus
        getRevealFocusTarget={() => {
          const capture = displayedCaptures
            .slice(visibleCount)
            .find((item) => !dirtyCaptureIds.has(item.id));
          return capture === undefined ? null : captureCard(capture.id);
        }}
        itemLabel="captures"
        totalCount={displayedCaptures.length}
        visibleCount={visibleCaptures.length}
        onReveal={(count) => {
          let next = visibleCount;
          let remaining = count - visibleCaptures.length;
          for (const capture of displayedCaptures.slice(visibleCount)) {
            if (remaining === 0) break;
            next += 1;
            if (!dirtyCaptureIds.has(capture.id)) remaining -= 1;
          }
          setVisibleCount(next);
        }}
      />
      {deletingCapture === null ? null : (
        <DestructiveActionDialog
          actionLabel="Delete capture"
          description="This permanently removes the capture, its images, and processing history. This action cannot be undone."
          fallbackFocus={() => sectionHeadingRef.current}
          failureMessage="Delete failed. Try again."
          isOpen
          returnFocusRef={deleteTriggerRef}
          title="Delete this capture?"
          onAction={async () => onDelete(deletingCapture.id)}
          onOpenChange={(isOpen) => {
            if (!isOpen) {
              setDeletingCapture(null);
            }
          }}
        />
      )}
    </>
  );
}

function CaptureCard({
  canWrite,
  wines,
  capture,
  locations,
  onImport,
  onSaveReview,
  onRequestDelete,
  onReviewDirtyChange,
  onRetry,
}: {
  readonly canWrite: boolean;
  readonly wines: readonly WineOption[];
  readonly capture: CaptureResource;
  readonly locations: readonly LocationItem[];
  readonly onImport: CaptureImportAction;
  readonly onSaveReview: CaptureReviewSaveAction;
  readonly onRequestDelete: (capture: CaptureResource, trigger: HTMLButtonElement) => void;
  readonly onReviewDirtyChange: (dirty: boolean) => void;
  readonly onRetry: (captureId: string) => Promise<boolean>;
}): ReactElement {
  const [pendingAction, setPendingAction] = useState<CaptureCardAction | null>(null);
  const pendingActionRef = useRef(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [hasUnsavedReview, setHasUnsavedReview] = useState(false);
  const [isReviewBusy, setIsReviewBusy] = useState(false);
  const canReview = capture.status === "needs_review" || capture.status === "failed";

  async function runAction(
    pending: CaptureCardAction,
    action: () => Promise<boolean | CaptureImportResult>,
  ): Promise<boolean> {
    if (pendingActionRef.current) {
      return false;
    }
    pendingActionRef.current = true;
    setPendingAction(pending);
    setActionError(null);
    try {
      const result = await action();
      const succeeded = typeof result === "boolean" ? result : result.ok;
      if (!succeeded) {
        setActionError(
          typeof result === "object" && !result.ok
            ? result.message
            : `${captureActionLabel(pending)} failed. Try again.`,
        );
      }
      return succeeded;
    } catch {
      setActionError(`${captureActionLabel(pending)} failed. Try again.`);
      return false;
    } finally {
      pendingActionRef.current = false;
      setPendingAction(null);
    }
  }

  return (
    <article
      className={`capture-card capture-${capture.status}`}
      data-capture-id={capture.id}
      tabIndex={-1}
    >
      <div className="card-title">
        <div>
          <h3>{captureTitle(capture)}</h3>
          <p>{captureStoragePath(capture, locations)}</p>
        </div>
        <Badge
          label={captureStatus(capture.status).label}
          variant={captureStatus(capture.status).badge}
        />
      </div>
      <div className="capture-thumbnails">
        {capture.images.map((image) => (
          <CaptureThumbnail image={image} key={image.imageAssetId} />
        ))}
      </div>
      <dl>
        <div>
          <dt>Quantity</dt>
          <dd>{capture.quantity}</dd>
        </div>
        <div>
          <dt>Candidate</dt>
          <dd>{candidateLabel(capture.reviewCandidate ?? capture.latestRun?.importCandidate)}</dd>
        </div>
        <div>
          <dt>Issue</dt>
          <dd>
            <CaptureIssue
              message={capture.errorMessage ?? capture.latestRun?.errorMessage ?? null}
            />
          </dd>
        </div>
      </dl>
      <ImportedCaptureReviewNotice status={capture.status} hasUnsavedReview={hasUnsavedReview} />
      {canReview || hasUnsavedReview || isReviewBusy ? (
        <CaptureReview
          capture={capture}
          wines={wines}
          canWrite={canWrite}
          disabled={pendingAction !== null || !canReview}
          onDirtyChange={(dirty) => {
            setHasUnsavedReview(dirty);
            onReviewDirtyChange(dirty);
          }}
          onBusyChange={setIsReviewBusy}
          onImport={onImport}
          onSaveReview={onSaveReview}
        />
      ) : null}
      <div className="card-actions">
        {canWrite && canReview ? (
          <Button
            isDisabled={pendingAction !== null || hasUnsavedReview || isReviewBusy}
            isLoading={isCaptureAction(pendingAction, { kind: "retry" })}
            label="Retry"
            size="sm"
            onClick={() => {
              void runAction({ kind: "retry" }, async () => onRetry(capture.id));
            }}
          />
        ) : null}
        {canWrite && isCaptureDeletable(capture) ? (
          <Button
            isDisabled={pendingAction !== null || isReviewBusy}
            label="Delete capture"
            size="sm"
            variant="destructive"
            onClick={(event: MouseEvent<HTMLButtonElement>) => {
              onRequestDelete(capture, event.currentTarget);
            }}
          />
        ) : null}
      </div>
      {actionError === null ? null : (
        <Banner aria-live="assertive" status="error" title={actionError} />
      )}
    </article>
  );
}

type CaptureCardAction =
  | { readonly kind: "create" }
  | { readonly kind: "import"; readonly wineVintageId: string }
  | { readonly kind: "retry" };

function captureCard(captureId: string): HTMLElement | null {
  return (
    [...document.querySelectorAll<HTMLElement>("[data-capture-id]")].find(
      (element) => element.dataset["captureId"] === captureId,
    ) ?? null
  );
}

function captureActionLabel(action: CaptureCardAction): string {
  return action.kind === "create" ? "Create new" : action.kind === "retry" ? "Retry" : "Import";
}

function isCaptureAction(current: CaptureCardAction | null, expected: CaptureCardAction): boolean {
  return (
    current !== null &&
    current.kind === expected.kind &&
    (current.kind !== "import" ||
      (expected.kind === "import" && current.wineVintageId === expected.wineVintageId))
  );
}

function isCaptureDeletable(capture: CaptureResource): boolean {
  return captureStatus(capture.status).deletable;
}

function isActionableCapture(capture: CaptureResource): boolean {
  return captureStatus(capture.status).actionable;
}

function CaptureIssue({ message }: { readonly message: string | null }): ReactElement {
  if (message === null || message === "") {
    return <span>None</span>;
  }

  const preview = compactIssuePreview(message);
  if (message.length <= preview.length) {
    return <span className="capture-issue">{message}</span>;
  }

  return (
    <details className="capture-disclosure">
      <summary>{preview}</summary>
      <p>{message}</p>
    </details>
  );
}

function compactIssuePreview(message: string): string {
  const firstLine = message.split("\n", 1)[0]?.trim() ?? "";
  const preview = firstLine === "" ? message.trim() : firstLine;
  return preview.length <= 180 ? preview : `${preview.slice(0, 177)}...`;
}

function captureStoragePath(capture: CaptureResource, locations: readonly LocationItem[]): string {
  return [
    capture.siteName,
    storageLocationLabel({
      locationId: capture.storageLocationId,
      locationName: capture.storageLocationName,
      locations,
    }),
    capture.positionHint,
  ]
    .filter((value) => value !== null && value !== "")
    .join(" / ");
}

function CaptureThumbnail({ image }: { readonly image: CaptureImageResource }): ReactElement {
  const filename = image.originalFilename ?? "Bottle photo";
  return (
    <div className="capture-photo">
      <Thumbnail alt={filename} label={filename} src={image.imageUrl} />
      <Link
        aria-label={`Open original photo ${filename}`}
        isExternalLink
        href={`${image.imageUrl}${image.imageUrl.includes("?") ? "&" : "?"}original=1`}
      >
        Open original
      </Link>
    </div>
  );
}

function captureTitle(capture: CaptureResource): string {
  const candidate = candidateLabel(capture.reviewCandidate ?? capture.latestRun?.importCandidate);
  return candidate === "No candidate yet" ? `Capture ${capture.id.slice(0, 8)}` : candidate;
}

function candidateLabel(value: unknown): string {
  const wine = candidateProperty(value, "wine");
  if (wine === null || typeof wine !== "object") return "No candidate yet";
  const text = (key: string) => {
    const field = candidateProperty(wine, key);
    return typeof field === "string" ? field : undefined;
  };
  const grapes = candidateProperty(wine, "grapeVarieties");
  const year = candidateProperty(wine, "vintageYear");
  const status = text("vintageStatus");
  return formatWineLabel({
    wineryName: text("wineryName"),
    brandName: text("brandName"),
    designation: text("designation"),
    appellation: text("appellation"),
    grapeVarieties: Array.isArray(grapes)
      ? grapes.filter((grape): grape is string => typeof grape === "string")
      : [],
    vintageYear: typeof year === "number" && Number.isFinite(year) ? year : undefined,
    vintageStatus:
      status === "year" || status === "non_vintage" || status === "unknown" ? status : undefined,
  });
}

function candidateProperty(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object"
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined;
}

function ImportedCaptureReviewNotice({
  status,
  hasUnsavedReview,
}: {
  readonly status: CaptureResource["status"];
  readonly hasUnsavedReview: boolean;
}): ReactElement | null {
  return status === "imported" && hasUnsavedReview ? (
    <p role="status">
      This capture was imported elsewhere. Your unsaved corrections remain below for reference.
    </p>
  ) : null;
}
