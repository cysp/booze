/* oxlint-disable import/max-dependencies -- One immutable bottle action owns its fields, evidence, and draft lifecycle. */
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { useEffect, useRef, useState, type ReactElement, type SubmitEvent } from "react";
import { useForm } from "react-hook-form";
import { formatWineLabel, hasWineIdentity } from "../shared/wine-identity.ts";
import { wineOptionLabel, type WineOption } from "../shared/wine-options.ts";
import {
  BottleFactFields,
  BottleStorageFields,
  WineIdentityFields,
  WineReferenceFields,
} from "./BottleActionFields.tsx";
import { AwardFields, CriticReviewFields } from "./BottleMetadataFields.tsx";
import { DestructiveActionDialog } from "./DestructiveActionDialog.tsx";
import { WineRecordPicker } from "./WineRecordPicker.tsx";
import {
  awardInputsForItem,
  criticReviewInputsForItem,
  validateAwards,
  validateCriticReviews,
  type AwardDraft,
  type AwardErrors,
  type ReviewErrors,
} from "./bottle-metadata.ts";
import {
  bottleFormSubmission,
  type BottleFormAction,
  type BottleModalSubmit,
  type BottleModalSubmitResult,
} from "./bottle-payload.ts";
import {
  formStateForItem,
  initialFormState,
  parseOptionalYear,
  type CriticReviewInput,
  type FormState,
  type LocationItem,
  type SiteItem,
} from "./inventory-model.ts";
import type { AuthHeadersProvider } from "./useReadPage.ts";

export type { BottleModalSubmit, BottleModalSubmitResult } from "./bottle-payload.ts";

type BottleModalProps = {
  readonly action: BottleFormAction;
  readonly isSaving: boolean;
  readonly getAuthHeaders: AuthHeadersProvider;
  readonly locations: readonly LocationItem[];
  readonly sites: readonly SiteItem[];
  readonly onClose: (siteId: string) => void;
  readonly onSubmit: (input: BottleModalSubmit) => Promise<BottleModalSubmitResult>;
};

export function bottleActionTitle(kind: BottleFormAction["kind"]): string {
  switch (kind) {
    case "add":
      return "Add bottle";
    case "move":
      return "Move bottle";
    case "edit-bottle":
      return "Edit bottle facts";
    case "correct-wine":
      return "Correct shared wine";
    case "reassign":
      return "Reassign this bottle";
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

function saveLabel(kind: BottleFormAction["kind"], unidentified: boolean): string {
  if (unidentified) return "Save as unidentified wine";
  switch (kind) {
    case "add":
      return "Save bottle";
    case "move":
      return "Move bottle";
    case "edit-bottle":
      return "Save bottle facts";
    case "correct-wine":
      return "Save wine corrections";
    case "reassign":
      return "Reassign bottle";
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

function actionDefaults(action: BottleFormAction): FormState {
  if (action.kind === "add") return action.form;
  if (action.kind === "reassign")
    return { ...initialFormState, siteId: action.item.siteId, site: action.item.siteName };
  return formStateForItem(action.item);
}

function fieldsForAction(kind: BottleFormAction["kind"]) {
  return {
    wine: ["add", "correct-wine", "reassign"].includes(kind),
    storage: ["add", "move"].includes(kind),
    bottle: ["add", "edit-bottle"].includes(kind),
    picker: ["add", "reassign"].includes(kind),
    editsStoredFacts: ["correct-wine", "edit-bottle"].includes(kind),
  };
}

export function BottleModal({
  action,
  isSaving,
  getAuthHeaders,
  locations,
  sites,
  onClose,
  onSubmit,
}: BottleModalProps): ReactElement {
  // A fixed action is a draft's lifetime; callers mount a new key to choose another action.
  const [draftAction] = useState(action);
  const fields = fieldsForAction(draftAction.kind);
  const [defaults] = useState(() => actionDefaults(draftAction));
  const sharedItem = draftAction.kind === "correct-wine" ? draftAction.item : undefined;
  const [originalReviews] = useState(() => criticReviewInputsForItem(sharedItem));
  const [originalAwards] = useState(() => awardInputsForItem(sharedItem));
  const [criticReviews, setCriticReviews] = useState<readonly CriticReviewInput[]>(originalReviews);
  const [awards, setAwards] = useState<readonly AwardDraft[]>(originalAwards);
  const [wineSelection, setWineSelection] = useState<{
    readonly id: string;
    readonly option: WineOption | undefined;
  }>({ id: "", option: undefined });
  const [reviewErrors, setReviewErrors] = useState<readonly ReviewErrors[]>([]);
  const [awardErrors, setAwardErrors] = useState<readonly AwardErrors[]>([]);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isDiscardOpen, setIsDiscardOpen] = useState(false);
  const [isPending, setIsPending] = useState(false);
  const pendingRef = useRef(false);
  const advancedRef = useRef<HTMLDetailsElement>(null);
  const {
    control,
    handleSubmit,
    setValue,
    watch,
    formState: { isDirty },
  } = useForm<FormState>({ defaultValues: defaults });
  const values = watch();
  const isBusy = isSaving || isPending;
  const reviewsChanged = JSON.stringify(criticReviews) !== JSON.stringify(originalReviews);
  const awardsChanged = JSON.stringify(awards) !== JSON.stringify(originalAwards);
  const hasUnsavedChanges = isDirty || wineSelection.id !== "" || reviewsChanged || awardsChanged;
  const wineEditable = fields.wine && wineSelection.id === "";
  const wineFacts = {
    wineryName: values.wineryName,
    brandName: values.brandName,
    designation: values.designation,
    grapeVarieties: values.grapeVarieties,
    appellation: values.appellation,
    vintageYear: parseOptionalYear(values.vintageYear),
    vintageStatus: values.vintageStatus,
  };
  const unidentified = wineEditable && !hasWineIdentity(wineFacts);
  const originalForm = fields.editsStoredFacts ? defaults : undefined;

  useEffect(() => {
    function warnBeforeUnload(event: BeforeUnloadEvent): void {
      event.preventDefault();
    }
    if (hasUnsavedChanges) window.addEventListener("beforeunload", warnBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", warnBeforeUnload);
    };
  }, [hasUnsavedChanges]);

  function revealErrors(): void {
    if (advancedRef.current !== null) advancedRef.current.open = true;
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>("[data-repeatable-error='true'], [aria-invalid='true']")
        ?.focus();
    });
  }

  const submit = handleSubmit(async (current) => {
    const validateReviews = wineEditable && (draftAction.kind !== "correct-wine" || reviewsChanged);
    const validateAwardRows =
      wineEditable && (draftAction.kind !== "correct-wine" || awardsChanged);
    const reviewsResult = validateCriticReviews(validateReviews ? criticReviews : []);
    const awardsResult = validateAwards(validateAwardRows ? awards : []);
    setReviewErrors(reviewsResult.errors);
    setAwardErrors(awardsResult.errors);
    if (!reviewsResult.ok || !awardsResult.ok) {
      revealErrors();
      return;
    }
    const evidence = {
      allowUnidentified: unidentified,
      ...(validateReviews ? { criticReviews: reviewsResult.values } : {}),
      ...(validateAwardRows ? { awards: awardsResult.values } : {}),
    };
    const result = await onSubmit(
      bottleFormSubmission(draftAction, current, evidence, wineSelection.id),
    );
    if (result.ok) onClose(current.siteId);
    else setSubmitError(result.message);
  }, revealErrors);

  async function save(event: SubmitEvent<HTMLFormElement>): Promise<void> {
    if (pendingRef.current || isSaving || isDiscardOpen) return;
    pendingRef.current = true;
    setIsPending(true);
    setSubmitError(null);
    try {
      await submit(event);
    } catch {
      setSubmitError(
        "The change could not be confirmed. Your details are still here; check your connection and try again.",
      );
    } finally {
      pendingRef.current = false;
      setIsPending(false);
    }
  }

  function changeOpen(open: boolean): void {
    if (open || pendingRef.current || isSaving || isDiscardOpen) return;
    if (hasUnsavedChanges) setIsDiscardOpen(true);
    else onClose(values.siteId);
  }

  return (
    <>
      <Dialog
        aria-label={bottleActionTitle(draftAction.kind)}
        isOpen
        maxHeight="calc(100dvh - 32px)"
        purpose="form"
        width="min(920px, calc(100vw - 32px))"
        onOpenChange={changeOpen}
      >
        <DialogHeader title={bottleActionTitle(draftAction.kind)} onOpenChange={changeOpen} />
        <form
          className="form-stack"
          onSubmit={(event) => {
            event.preventDefault();
            void save(event);
          }}
        >
          <fieldset className="form-stack bottle-form-fields" disabled={isBusy || isDiscardOpen}>
            <ActionExplanation action={draftAction} />
            {fields.storage ? (
              <BottleStorageFields
                control={control}
                setValue={setValue}
                watch={watch}
                locations={locations}
                sites={sites}
                adding={draftAction.kind === "add"}
                onSiteChange={() => {
                  setWineSelection({ id: "", option: undefined });
                }}
              />
            ) : null}
            {fields.picker ? (
              <WineRecordPicker
                siteId={values.siteId}
                selected={wineSelection.id}
                getAuthHeaders={getAuthHeaders}
                excludedId={
                  draftAction.kind === "reassign" ? draftAction.item.wineVintageId : undefined
                }
                label="Wine record"
                allowNew
                onChange={(id, option) => {
                  setWineSelection({ id, option });
                }}
              />
            ) : null}
            {wineSelection.option === undefined ? null : (
              <section aria-label="Selected wine details">
                <h3>{wineOptionLabel(wineSelection.option)}</h3>
                <p>Existing wine facts and evidence will be used without changing that wine.</p>
              </section>
            )}
            {wineEditable ? (
              <>
                <WineIdentityFields
                  control={control}
                  originalForm={originalForm}
                  setValue={setValue}
                  watch={watch}
                />
                <p>Catalogue title: {formatWineLabel(wineFacts)}</p>
                {unidentified ? (
                  <p>
                    Wine details are incomplete. Choose “Save as unidentified wine” to save now and
                    complete them later.
                  </p>
                ) : null}
                <details ref={advancedRef} className="form-section">
                  <summary>Wine reference and evidence</summary>
                  <p className="field-hint">
                    Edit origin, style, drinking advice, label text, source notes, critic reviews
                    and awards deliberately.
                  </p>
                  <WineReferenceFields control={control} originalForm={originalForm} />
                  <CriticReviewFields
                    errors={reviewErrors}
                    reviews={criticReviews}
                    onChange={(next) => {
                      setCriticReviews(next);
                      setReviewErrors([]);
                    }}
                  />
                  <AwardFields
                    errors={awardErrors}
                    awards={awards}
                    onChange={(next) => {
                      setAwards(next);
                      setAwardErrors([]);
                    }}
                  />
                </details>
              </>
            ) : null}
            {fields.bottle ? (
              <BottleFactFields
                control={control}
                originalForm={originalForm}
                adding={draftAction.kind === "add"}
              />
            ) : null}
          </fieldset>
          <div className="dialog-actions">
            <Button
              isDisabled={isBusy || isDiscardOpen}
              isLoading={isBusy}
              label={saveLabel(draftAction.kind, unidentified)}
              type="submit"
              variant="primary"
            />
          </div>
          {submitError === null ? null : <Banner role="alert" status="error" title={submitError} />}
        </form>
      </Dialog>
      <DestructiveActionDialog
        actionLabel="Discard changes"
        description="Your unsaved changes will be discarded. Stored facts and evidence will stay as they are."
        failureMessage="The form could not be closed. Try again."
        isOpen={isDiscardOpen}
        title="Discard unsaved changes?"
        onAction={async () => true}
        onOpenChange={setIsDiscardOpen}
        onSuccess={() => {
          onClose(values.siteId);
        }}
      />
    </>
  );
}

function ActionExplanation({ action }: { readonly action: BottleFormAction }): ReactElement | null {
  if (action.kind === "correct-wine")
    return (
      <Banner
        status="warning"
        title={`Corrections will update all ${action.item.wineBottleCount} linked ${action.item.wineBottleCount === 1 ? "bottle" : "bottles"}.`}
      />
    );
  if (action.kind === "reassign")
    return (
      <p>
        This changes only this bottle's wine assignment. The original wine, reviews, awards and
        source evidence stay with their original record. A new wine starts with empty facts and
        evidence.
      </p>
    );
  return null;
}
