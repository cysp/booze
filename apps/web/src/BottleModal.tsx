import { wineOptionLabel, type WineOption } from "../shared/wine-options.ts";
/* oxlint-disable import/max-dependencies -- Bottle editing composes ASTRYX fields, dialogs, and domain adapters. */
import { Button } from "@astryxdesign/core/Button";
import { Selector } from "@astryxdesign/core/Selector";
import { Banner } from "@astryxdesign/core/Banner";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import {
  useEffect,
  useRef,
  useState,
  type SubmitEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { useForm, type Control, type UseFormSetValue, type UseFormWatch } from "react-hook-form";

import { formatWineLabel, hasWineIdentity } from "../shared/wine-identity.ts";
import { parseGrapeVarieties } from "./bottle-metadata.ts";
import { parseOptionalYear } from "./inventory-model.ts";
import { BottleLocationPicker } from "./BottleLocationPicker.tsx";
import { AwardFields, CriticReviewFields } from "./BottleMetadataFields.tsx";
import { DestructiveActionDialog } from "./DestructiveActionDialog.tsx";
import {
  BottleQuantityInput,
  BottleTextArea,
  BottleTextInput,
  type BottleFormFieldProps,
} from "./BottleFormFields.tsx";
import {
  awardInputsForItem,
  criticReviewInputsForItem,
  validateAwards,
  validateCriticReviews,
  type AwardDraft,
  type AwardErrors,
  type ReviewErrors,
} from "./bottle-metadata.ts";
import type {
  CriticReviewInput,
  FormState,
  InventoryItem,
  LocationItem,
  SiteItem,
  WineAwardInput,
} from "./inventory-model.ts";

type BottleModalProps = {
  readonly form: FormState;
  readonly isSaving: boolean;
  readonly item?: InventoryItem;
  readonly wines?: readonly WineOption[];
  readonly locations: readonly LocationItem[];
  readonly sites: readonly SiteItem[];
  readonly title: string;
  readonly onClose: (siteId: string) => void;
  readonly onDelete?: () => Promise<boolean>;
  readonly onMarkConsumed?: () => Promise<boolean>;
  readonly onSubmit: (input: BottleModalSubmit) => Promise<BottleModalSubmitResult>;
};

export type BottleModalSubmit = {
  readonly wineEditScope?: "shared" | "bottle" | undefined;
  readonly wineVintageId?: string | undefined;
  readonly allowUnidentified?: boolean | undefined;
  readonly awards: readonly WineAwardInput[];
  readonly criticReviews: readonly CriticReviewInput[];
  readonly form: FormState;
};

export type BottleModalSubmitResult =
  | { readonly ok: true }
  | { readonly message: string; readonly ok: false };

type FormFieldConfig = Omit<BottleFormFieldProps, "control">;

const identityFields = [
  { label: "Label / brand", name: "brandName", placeholder: "Rowlee" },
  { label: "Winery", name: "wineryName", placeholder: "Rowlee Wines" },
  {
    label: "Designation (optional)",
    name: "designation",
    placeholder: "Pinnacle Series",
    description:
      "A separate name, range, vineyard or designation printed on the label, if present.",
  },
  {
    label: "Grape varieties",
    name: "grapeVarieties",
    placeholder: "Shiraz, Cabernet Sauvignon",
  },
] satisfies readonly FormFieldConfig[];

const originFields = [
  { label: "Region", name: "region", placeholder: "Orange" },
  { label: "Country", name: "country", placeholder: "Australia" },
  { label: "Appellation", name: "appellation", placeholder: "Orange GI" },
  { label: "Classification", name: "classification", placeholder: "Grand Cru" },
  { label: "Style", name: "wineType", placeholder: "Red wine" },
  { label: "Colour", name: "wineColor", placeholder: "Red" },
  { label: "Alcohol", name: "alcoholPercent", placeholder: "13.5% alc/vol" },
] satisfies readonly FormFieldConfig[];

const referenceFields = [
  {
    label: "Description",
    name: "description",
    placeholder: "Visible winery description or tasting copy",
  },
  {
    label: "Drinking advice",
    name: "drinkingAdvice",
    placeholder: "Cellaring or serving advice",
  },
  { label: "Label text", name: "labelText", placeholder: "Paste label, OCR, or winery page text" },
  {
    label: "Wine notes",
    name: "wineNotes",
    placeholder: "Tasting notes, food pairing, source details",
  },
] satisfies readonly FormFieldConfig[];

export function BottleModal({
  form,
  isSaving,
  item,
  wines = [],
  locations,
  sites,
  title,
  onClose,
  onDelete,
  onMarkConsumed,
  onSubmit,
}: BottleModalProps): ReactElement {
  const [wineEditMode, setWineEditMode] = useState<"none" | "shared" | "bottle">("none");
  const [wineVintageId, setWineVintageId] = useState("");
  const [criticReviews, setCriticReviews] = useState<readonly CriticReviewInput[]>(
    criticReviewInputsForItem(item),
  );
  const [awards, setAwards] = useState<readonly AwardDraft[]>(awardInputsForItem(item));
  const [newWineReviews, setNewWineReviews] = useState<readonly CriticReviewInput[]>([]);
  const [newWineAwards, setNewWineAwards] = useState<readonly AwardDraft[]>([]);
  const { activeReviews, activeAwards, changeReviews, changeAwards } = evidenceForMode(
    wineEditMode,
    {
      activeReviews: criticReviews,
      activeAwards: awards,
      changeReviews: setCriticReviews,
      changeAwards: setAwards,
    },
    {
      activeReviews: newWineReviews,
      activeAwards: newWineAwards,
      changeReviews: setNewWineReviews,
      changeAwards: setNewWineAwards,
    },
  );
  const [reviewErrors, setReviewErrors] = useState<readonly ReviewErrors[]>([]);
  const [awardErrors, setAwardErrors] = useState<readonly AwardErrors[]>([]);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const deleteTriggerRef = useRef<HTMLButtonElement>(null);
  const [isDiscardOpen, setIsDiscardOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<"save" | "consume" | "delete" | null>(null);
  const pendingActionRef = useRef<typeof pendingAction>(null);
  const originalReviews = useRef(JSON.stringify(criticReviews));
  const originalAwards = useRef(JSON.stringify(awards));
  const [consumeError, setConsumeError] = useState<string | null>(null);
  const {
    control,
    handleSubmit,
    setValue,
    watch,
    formState: { isDirty },
  } = useForm<FormState>({ defaultValues: form });

  const isBusy = isSaving || pendingAction !== null;
  const hasUnsavedChanges =
    isDirty ||
    hasWineEditIntent(wineEditMode, wineVintageId, newWineReviews.length + newWineAwards.length) ||
    repeatablesChanged(criticReviews, originalReviews.current, awards, originalAwards.current);

  const currentValues = watch();
  const wineEditable = canEditWine(item, wineEditMode, wineVintageId);
  const needsIdentityConfirmation = needsWineIdentityConfirmation(wineEditable, currentValues);

  useEffect(() => {
    function warnBeforeUnload(event: BeforeUnloadEvent): void {
      event.preventDefault();
    }
    if (hasUnsavedChanges) {
      window.addEventListener("beforeunload", warnBeforeUnload);
    }
    return () => {
      window.removeEventListener("beforeunload", warnBeforeUnload);
    };
  }, [hasUnsavedChanges]);

  function beginAction(action: NonNullable<typeof pendingAction>): boolean {
    if (pendingActionRef.current !== null || isSaving) {
      return false;
    }
    pendingActionRef.current = action;
    setPendingAction(action);
    return true;
  }

  function finishAction(): void {
    pendingActionRef.current = null;
    setPendingAction(null);
  }

  const submitForm = handleSubmit(async (values) => {
    setSubmitError(null);
    const reviewsResult = validateCriticReviews(wineEditable ? activeReviews : []);
    const awardsResult = validateAwards(wineEditable ? activeAwards : []);
    setReviewErrors(reviewsResult.errors);
    setAwardErrors(awardsResult.errors);
    if (!reviewsResult.ok || !awardsResult.ok) {
      requestAnimationFrame(() => {
        document.querySelector<HTMLElement>("[data-repeatable-error='true']")?.focus();
      });
      return;
    }
    const result = await onSubmit({
      wineEditScope: item === undefined || wineEditMode === "none" ? undefined : wineEditMode,
      wineVintageId: wineVintageId === "" ? undefined : wineVintageId,
      allowUnidentified: needsIdentityConfirmation,
      awards: awardsResult.values,
      criticReviews: reviewsResult.values,
      form: values,
    });
    if (!result.ok) {
      setSubmitError(result.message);
    }
  });

  async function saveForm(event: SubmitEvent<HTMLFormElement>): Promise<void> {
    if (isDeleteOpen || isDiscardOpen || !beginAction("save")) {
      return;
    }
    try {
      await submitForm(event);
    } catch {
      setSubmitError("Bottle was not saved. Check your connection and try again.");
    } finally {
      finishAction();
    }
  }

  async function markConsumed(): Promise<void> {
    if (onMarkConsumed === undefined || hasUnsavedChanges || !beginAction("consume")) {
      return;
    }
    setConsumeError(null);
    try {
      const updated = await onMarkConsumed();
      if (!updated) {
        setConsumeError("Bottle was not marked drunk. Try again.");
      }
    } catch {
      setConsumeError("Bottle was not marked drunk. Try again.");
    } finally {
      finishAction();
    }
  }

  function changeOpen(isOpen: boolean): void {
    if (isOpen || pendingActionRef.current !== null || isSaving || isDeleteOpen || isDiscardOpen) {
      return;
    }
    if (hasUnsavedChanges) {
      setIsDiscardOpen(true);
    } else {
      onClose(currentValues.siteId);
    }
  }

  return (
    <>
      <Dialog
        aria-label={title}
        isOpen
        maxHeight="calc(100dvh - 32px)"
        purpose="form"
        width="min(920px, calc(100vw - 32px))"
        onOpenChange={changeOpen}
      >
        <DialogHeader
          subtitle={
            item === undefined
              ? "Review the cellar record before saving."
              : "Storage and bottle notes apply to this bottle. Choose explicitly whether to correct shared wine details or identify this bottle as a different wine."
          }
          title={title}
          onOpenChange={changeOpen}
        />
        <form
          className="form-stack"
          onSubmit={(event) => {
            event.preventDefault();
            void saveForm(event);
          }}
        >
          <fieldset className="form-stack bottle-form-fields" disabled={isBusy}>
            <WineEditControls
              item={item}
              wines={wines}
              values={currentValues}
              wineEditMode={wineEditMode}
              wineVintageId={wineVintageId}
              setWineEditMode={(mode) => {
                setWineEditMode(mode);
                setReviewErrors([]);
                setAwardErrors([]);
              }}
              setWineVintageId={setWineVintageId}
            />
            <BottleFields
              wineEditable={wineEditable}
              hideWineDetails={wineVintageId !== ""}
              onSiteChange={() => {
                setWineVintageId("");
              }}
              control={control}
              disableSiteSelection={item !== undefined}
              locations={locations}
              setValue={setValue}
              showQuantity={item === undefined}
              sites={sites}
              watch={watch}
            />
            <div hidden={wineVintageId !== ""}>
              <fieldset className="form-stack bottle-form-fields" disabled={!wineEditable}>
                <NewWineEvidenceHint mode={wineEditMode} />
                <CriticReviewFields
                  errors={reviewErrors}
                  reviews={activeReviews}
                  onChange={(next) => {
                    changeReviews(next);
                    setReviewErrors([]);
                  }}
                />
                <AwardFields
                  awards={activeAwards}
                  errors={awardErrors}
                  onChange={(next) => {
                    changeAwards(next);
                    setAwardErrors([]);
                  }}
                />
              </fieldset>
            </div>
          </fieldset>
          <div className="dialog-actions">
            <Button
              isDisabled={isBusy || isDeleteOpen || isDiscardOpen}
              isLoading={isSaving || pendingAction === "save"}
              label={bottleSaveLabel(needsIdentityConfirmation)}
              type="submit"
              variant="primary"
            />
            {onMarkConsumed === undefined ? null : (
              <Button
                isDisabled={isBusy || hasUnsavedChanges || isDeleteOpen || isDiscardOpen}
                isLoading={pendingAction === "consume"}
                label="Mark drunk"
                onClick={() => {
                  void markConsumed();
                }}
              />
            )}
            {onDelete === undefined ? null : (
              <Button
                ref={deleteTriggerRef}
                isDisabled={isBusy || isDiscardOpen}
                label="Delete bottle"
                variant="destructive"
                onClick={() => {
                  setIsDeleteOpen(true);
                }}
              />
            )}
            {onMarkConsumed !== undefined && hasUnsavedChanges ? (
              <p className="field-hint">Save your changes before marking this bottle drunk.</p>
            ) : null}
            {consumeError === null ? null : (
              <Banner role="alert" status="error" title={consumeError} />
            )}
            {submitError === null ? null : (
              <Banner role="alert" status="error" title={submitError} />
            )}
          </div>
        </form>
      </Dialog>
      <DestructiveActionDialog
        actionLabel="Discard changes"
        description="Your unsaved changes will be discarded. The stored bottle record will stay as it is."
        failureMessage="The editor could not be closed. Try again."
        isOpen={isDiscardOpen}
        title="Discard unsaved changes?"
        onAction={async () => true}
        onOpenChange={setIsDiscardOpen}
        onSuccess={() => {
          onClose(currentValues.siteId);
        }}
      />
      {onDelete === undefined ? null : (
        <DestructiveActionDialog
          actionLabel="Delete bottle"
          description="This permanently removes this bottle and its inventory record. This action cannot be undone."
          failureMessage="Bottle was not deleted. Try again."
          isOpen={isDeleteOpen}
          returnFocusRef={deleteTriggerRef}
          title="Delete this bottle?"
          onAction={async () => {
            if (!beginAction("delete")) {
              return false;
            }
            try {
              return await onDelete();
            } finally {
              finishAction();
            }
          }}
          onOpenChange={setIsDeleteOpen}
          onSuccess={() => {
            onClose(currentValues.siteId);
          }}
        />
      )}
    </>
  );
}

type WineEditMode = "none" | "shared" | "bottle";

function repeatablesChanged(
  reviews: readonly CriticReviewInput[],
  originalReviews: string,
  awards: readonly AwardDraft[],
  originalAwards: string,
): boolean {
  return JSON.stringify(reviews) !== originalReviews || JSON.stringify(awards) !== originalAwards;
}

function bottleSaveLabel(unidentified: boolean): string {
  return unidentified ? "Save as unidentified wine" : "Save bottle";
}

function needsWineIdentityConfirmation(editable: boolean, values: FormState): boolean {
  return editable && !hasWineIdentity(wineFactsForForm(values));
}

function hasWineEditIntent(mode: WineEditMode, target: string, newEvidenceCount: number): boolean {
  return mode === "bottle" || target !== "" || newEvidenceCount > 0;
}

function canEditWine(item: InventoryItem | undefined, mode: WineEditMode, target: string): boolean {
  return (item === undefined || mode !== "none") && target === "";
}

function wineFactsForForm(values: FormState) {
  return {
    wineryName: values.wineryName,
    brandName: values.brandName,
    designation: values.designation,
    grapeVarieties: parseGrapeVarieties(values.grapeVarieties),
    appellation: values.appellation,
    vintageYear: parseOptionalYear(values.vintageYear),
    vintageStatus: values.vintageStatus,
  };
}

function evidenceForMode<T>(mode: WineEditMode, shared: T, separate: T): T {
  return mode === "bottle" ? separate : shared;
}

function NewWineEvidenceHint({ mode }: { readonly mode: WineEditMode }): ReactElement | null {
  return mode === "bottle" ? (
    <p>
      Reviews and awards below belong to the new wine. The original wine's evidence stays with its
      original record.
    </p>
  ) : null;
}

function SelectedWineSummary({
  item,
}: {
  readonly item: WineOption | undefined;
}): ReactElement | null {
  if (item === undefined) return null;
  return (
    <section aria-label="Selected wine details">
      <h3>{wineOptionLabel(item)}</h3>
      <p>
        {[item.wineryName, item.grapeVarieties.join(", "), item.region]
          .filter(Boolean)
          .join(" · ") || "Unidentified wine"}
      </p>
      <p>Existing wine details will be used for this bottle.</p>
    </section>
  );
}

function WineEditControls({
  item,
  wines,
  values,
  wineEditMode,
  wineVintageId,
  setWineEditMode,
  setWineVintageId,
}: {
  readonly item: InventoryItem | undefined;
  readonly wines: readonly WineOption[];
  readonly values: FormState;
  readonly wineEditMode: WineEditMode;
  readonly wineVintageId: string;
  readonly setWineEditMode: (mode: WineEditMode) => void;
  readonly setWineVintageId: (id: string) => void;
}): ReactElement {
  const wineFacts = wineFactsForForm(values);
  const wineEditable = canEditWine(item, wineEditMode, wineVintageId);
  const needsIdentityConfirmation = wineEditable && !hasWineIdentity(wineFacts);
  const selectableWines = [
    ...new Map(
      wines
        .filter(
          (candidate) =>
            candidate.siteId === values.siteId && candidate.wineVintageId !== item?.wineVintageId,
        )
        .map((candidate) => [candidate.wineVintageId, candidate]),
    ).values(),
  ];
  return (
    <>
      {item === undefined ? null : (
        <Selector
          label="What are you editing?"
          value={wineEditMode}
          options={[
            { value: "none", label: "Bottle details only" },
            { value: "shared", label: "Correct wine details" },
            { value: "bottle", label: "This bottle is a different wine" },
          ]}
          onChange={(value: string) => {
            if (value === "none" || value === "shared" || value === "bottle") {
              setWineEditMode(value);
              setWineVintageId("");
            }
          }}
        />
      )}
      {item !== undefined && wineEditMode === "shared" ? (
        <Banner
          status="warning"
          title={`Corrections will update all ${item.wineBottleCount} linked ${item.wineBottleCount === 1 ? "bottle" : "bottles"}.`}
        />
      ) : null}
      {item === undefined || wineEditMode === "bottle" ? (
        <Selector
          label="Wine record"
          value={wineVintageId}
          options={[
            { value: "", label: "Create a separate wine record" },
            ...selectableWines.map((candidate) => ({
              value: candidate.wineVintageId,
              label: wineOptionLabel(candidate),
              description: candidate.wineVintageId,
            })),
          ]}
          description="Choose an existing wine explicitly, or save a separate record. Similar details never merge wine records."
          onChange={(value: string) => {
            setWineVintageId(value);
          }}
        />
      ) : null}
      <SelectedWineSummary
        item={selectableWines.find((candidate) => candidate.wineVintageId === wineVintageId)}
      />
      {wineEditable ? <p>Catalogue title: {formatWineLabel(wineFacts)}</p> : null}
      {needsIdentityConfirmation ? (
        <p>
          Wine details are incomplete. Choose “Save as unidentified wine” to save now and complete
          them later.
        </p>
      ) : null}
    </>
  );
}

function BottleFields({
  hideWineDetails,
  onSiteChange,
  wineEditable,
  control,
  disableSiteSelection,
  locations,
  setValue,
  showQuantity,
  sites,
  watch,
}: {
  readonly control: Control<FormState>;
  readonly wineEditable: boolean;
  readonly hideWineDetails: boolean;
  readonly onSiteChange: () => void;
  readonly disableSiteSelection: boolean;
  readonly locations: readonly LocationItem[];
  readonly setValue: UseFormSetValue<FormState>;
  readonly showQuantity: boolean;
  readonly sites: readonly SiteItem[];
  readonly watch: UseFormWatch<FormState>;
}): ReactElement {
  const vintageStatus = watch("vintageStatus");
  const selectedSiteId = watch("siteId");
  const selectedStorageLocationId = watch("storageLocationId");
  return (
    <>
      <div hidden={hideWineDetails}>
        <fieldset className="form-stack bottle-form-fields" disabled={!wineEditable}>
          <FormSection title="Wine identity">
            <FieldGrid control={control} fields={identityFields} disabled={!wineEditable} />
            <Selector
              label="Vintage status"
              value={vintageStatus}
              options={[
                { value: "unknown", label: "Unknown vintage" },
                { value: "year", label: "Vintage year" },
                { value: "non_vintage", label: "Explicitly non-vintage (NV)" },
              ]}
              onChange={(value: string) => {
                if (value === "year" || value === "unknown" || value === "non_vintage") {
                  setValue("vintageStatus", value, { shouldDirty: true });
                  if (value !== "year") setValue("vintageYear", "", { shouldDirty: true });
                }
              }}
            />
            {vintageStatus === "year" ? (
              <BottleTextInput
                control={control}
                label="Vintage"
                name="vintageYear"
                placeholder="2023"
                required
                disabled={!wineEditable}
              />
            ) : null}
          </FormSection>
          <FormSection title="Origin and style">
            <FieldGrid control={control} fields={originFields} disabled={!wineEditable} />
          </FormSection>
          <BottleTextArea
            control={control}
            disabled={!wineEditable}
            label="Producer address"
            name="addressQualification"
            placeholder="Produced by, bottled by, or address"
          />
        </fieldset>
      </div>
      <FormSection title="Bottle and storage">
        <FieldGrid
          control={control}
          fields={[
            {
              label: "Bottle size",
              name: "bottleVolumeMl",
              placeholder: "750ml",
              required: !showQuantity,
            },
            { label: "Barcode", name: "barcode", placeholder: "9342675000444" },
          ]}
        />
        <BottleLocationPicker
          disabledSite={disableSiteSelection}
          idPrefix={showQuantity ? "add-bottle-storage" : "edit-bottle-storage"}
          locations={locations}
          selectedSiteId={selectedSiteId}
          selectedStorageLocationId={selectedStorageLocationId}
          sites={sites}
          onChange={(selection) => {
            if (selection.siteId !== selectedSiteId) onSiteChange();
            setValue("siteId", selection.siteId, { shouldDirty: true, shouldTouch: true });
            setValue("site", selection.site, { shouldDirty: true, shouldTouch: true });
            setValue("storageLocationId", selection.storageLocationId, {
              shouldDirty: true,
              shouldTouch: true,
            });
            setValue("location", selection.location, { shouldDirty: true, shouldTouch: true });
            if (selection.storageLocationId === "") {
              setValue("position", "", { shouldDirty: true, shouldTouch: true });
            }
          }}
        />
        <FieldGrid
          control={control}
          fields={
            showQuantity
              ? [{ label: "Lot code", name: "lotCode", placeholder: "L23051" }]
              : [
                  { label: "Lot code", name: "lotCode", placeholder: "L23051" },
                  {
                    label: "Position note",
                    name: "position",
                    placeholder: "Row 3, slot 2",
                    disabled: selectedStorageLocationId === "",
                    description:
                      selectedStorageLocationId === ""
                        ? "Choose a location to add a position note."
                        : undefined,
                  },
                ]
          }
        />
        {showQuantity ? <BottleQuantityInput control={control} /> : null}
        <BottleTextArea
          control={control}
          label="Bottle notes"
          name="bottleNotes"
          placeholder="Condition, purchase source, box details"
        />
        {showQuantity ? (
          <BottleTextInput
            control={control}
            label="Position note"
            name="position"
            placeholder="Row 3, slot 2"
            disabled={selectedStorageLocationId === ""}
            description={
              selectedStorageLocationId === ""
                ? "Choose a location to add a position note."
                : undefined
            }
          />
        ) : null}
      </FormSection>
      <div hidden={hideWineDetails}>
        <fieldset className="form-stack bottle-form-fields" disabled={!wineEditable}>
          <FormSection title="Drink window">
            <FieldGrid
              disabled={!wineEditable}
              control={control}
              fields={[
                { label: "Drink from", name: "drinkFromYear", placeholder: "2025" },
                { label: "Drink to", name: "drinkToYear", placeholder: "2032" },
                {
                  label: "Source URL",
                  name: "sourceUrl",
                  placeholder: "https://winery.example/wine",
                },
              ]}
            />
          </FormSection>
          <FormSection title="Wine reference">
            {referenceFields.map((field) => (
              <BottleTextArea
                control={control}
                key={field.name}
                disabled={!wineEditable}
                {...field}
              />
            ))}
          </FormSection>
        </fieldset>
      </div>
    </>
  );
}

function FormSection({
  children,
  title,
}: {
  readonly children: ReactNode;
  readonly title: string;
}): ReactElement {
  return (
    <section className="form-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function FieldGrid({
  disabled = false,
  control,
  fields,
}: {
  readonly control: Control<FormState>;
  readonly fields: readonly FormFieldConfig[];
  readonly disabled?: boolean;
}): ReactElement {
  return (
    <div className="field-row">
      {fields.map((field) => (
        <BottleTextInput
          control={control}
          key={field.name}
          {...field}
          disabled={disabled || field.disabled === true}
        />
      ))}
    </div>
  );
}
