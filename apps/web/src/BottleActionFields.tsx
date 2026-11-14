import { Selector } from "@astryxdesign/core/Selector";
import type { ReactElement } from "react";
import type { Control, UseFormSetValue, UseFormWatch } from "react-hook-form";
import { BottleLocationPicker } from "./BottleLocationPicker.tsx";
import {
  BottleQuantityInput,
  BottleTextArea,
  BottleTextInput,
  type BottleFormFieldProps,
} from "./BottleFormFields.tsx";
import { GrapeVarietiesInput } from "./GrapeVarietiesInput.tsx";
import type { FormState, LocationItem, SiteItem } from "./inventory-model.ts";

type FieldsProps = {
  readonly control: Control<FormState>;
  readonly originalForm?: FormState | undefined;
};
type FieldConfig = Omit<BottleFormFieldProps, "control" | "originalForm">;

export function BottleFactFields({
  control,
  originalForm,
  adding,
}: FieldsProps & { readonly adding: boolean }): ReactElement {
  return (
    <section className="form-section">
      <h3>Bottle facts</h3>
      <FieldGrid
        control={control}
        originalForm={originalForm}
        fields={[
          { label: "Bottle size", name: "bottleVolumeMl", placeholder: "750ml", required: !adding },
          {
            label: "Bottle number",
            name: "bottleNumber",
            placeholder: "Physical bottle reference",
          },
          { label: "Barcode", name: "barcode", placeholder: "9342675000444" },
          { label: "Lot code", name: "lotCode", placeholder: "L23051" },
        ]}
      />
      {adding ? <BottleQuantityInput control={control} /> : null}
      <BottleTextArea
        control={control}
        originalForm={originalForm}
        label="Bottle notes"
        name="bottleNotes"
        placeholder="Condition, purchase source, box details"
      />
    </section>
  );
}

export function BottleStorageFields({
  control,
  setValue,
  watch,
  locations,
  sites,
  adding,
  onSiteChange,
}: FieldsProps & {
  readonly setValue: UseFormSetValue<FormState>;
  readonly watch: UseFormWatch<FormState>;
  readonly locations: readonly LocationItem[];
  readonly sites: readonly SiteItem[];
  readonly adding: boolean;
  readonly onSiteChange: () => void;
}): ReactElement {
  const siteId = watch("siteId");
  const storageLocationId = watch("storageLocationId");
  return (
    <section className="form-section">
      <h3>Storage</h3>
      <BottleLocationPicker
        disabledSite={!adding}
        idPrefix={adding ? "add-bottle-storage" : "move-bottle-storage"}
        locations={locations}
        sites={sites}
        selectedSiteId={siteId}
        selectedStorageLocationId={storageLocationId}
        onChange={(selection) => {
          if (selection.siteId !== siteId) onSiteChange();
          setValue("siteId", selection.siteId, { shouldDirty: true, shouldTouch: true });
          setValue("site", selection.site, { shouldDirty: true });
          setValue("storageLocationId", selection.storageLocationId, {
            shouldDirty: true,
            shouldTouch: true,
          });
          setValue("location", selection.location, { shouldDirty: true });
          if (selection.storageLocationId === "") setValue("position", "", { shouldDirty: true });
        }}
      />
      <BottleTextInput
        control={control}
        label="Position note"
        name="position"
        placeholder="Row 3, slot 2"
        disabled={storageLocationId === ""}
        description={
          storageLocationId === "" ? "Choose a location to add a position note." : undefined
        }
      />
    </section>
  );
}

export function WineIdentityFields({
  control,
  originalForm,
  setValue,
  watch,
}: FieldsProps & {
  readonly setValue: UseFormSetValue<FormState>;
  readonly watch: UseFormWatch<FormState>;
}): ReactElement {
  const vintageStatus = watch("vintageStatus");
  return (
    <section className="form-section">
      <h3>Wine identity</h3>
      <FieldGrid
        control={control}
        originalForm={originalForm}
        fields={[
          { label: "Label / brand", name: "brandName", placeholder: "Rowlee" },
          { label: "Winery", name: "wineryName", placeholder: "Rowlee Wines" },
          {
            label: "Designation (optional)",
            name: "designation",
            placeholder: "Pinnacle Series",
            description:
              "A separate name, range, vineyard or designation printed on the label, if present.",
          },
        ]}
      />
      <GrapeVarietiesInput
        name="grapeVarieties"
        value={watch("grapeVarieties")}
        onChange={(value) => {
          setValue("grapeVarieties", value, { shouldDirty: true, shouldTouch: true });
        }}
      />
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
          originalForm={originalForm}
          label="Vintage"
          name="vintageYear"
          placeholder="2023"
          required
        />
      ) : null}
    </section>
  );
}

export function WineReferenceFields({ control, originalForm }: FieldsProps): ReactElement {
  return (
    <>
      <section className="form-section">
        <h3>Origin and style</h3>
        <FieldGrid
          control={control}
          originalForm={originalForm}
          fields={[
            { label: "Region", name: "region", placeholder: "Orange" },
            { label: "Country", name: "country", placeholder: "Australia" },
            { label: "Appellation", name: "appellation", placeholder: "Orange GI" },
            { label: "Classification", name: "classification", placeholder: "Grand Cru" },
            { label: "Style", name: "wineType", placeholder: "Red wine" },
            { label: "Colour", name: "wineColor", placeholder: "Red" },
            { label: "Alcohol", name: "alcoholPercent", placeholder: "13.5% alc/vol" },
          ]}
        />
        <BottleTextArea
          control={control}
          originalForm={originalForm}
          label="Producer address"
          name="addressQualification"
        />
      </section>
      <section className="form-section">
        <h3>Drink window</h3>
        <FieldGrid
          control={control}
          originalForm={originalForm}
          fields={[
            { label: "Drink from", name: "drinkFromYear", placeholder: "2025" },
            { label: "Drink to", name: "drinkToYear", placeholder: "2032" },
            { label: "Source URL", name: "sourceUrl", placeholder: "https://winery.example/wine" },
          ]}
        />
      </section>
      <section className="form-section">
        <h3>Wine reference</h3>
        {(
          [
            { label: "Description", name: "description" },
            { label: "Drinking advice", name: "drinkingAdvice" },
            { label: "Label text", name: "labelText" },
            { label: "Wine notes", name: "wineNotes" },
          ] satisfies readonly FieldConfig[]
        ).map((field) => (
          <BottleTextArea
            key={field.name}
            control={control}
            originalForm={originalForm}
            {...field}
          />
        ))}
      </section>
    </>
  );
}

function FieldGrid({
  control,
  originalForm,
  fields,
}: FieldsProps & { readonly fields: readonly FieldConfig[] }): ReactElement {
  return (
    <div className="field-row">
      {fields.map((field) => (
        <BottleTextInput
          key={field.name}
          control={control}
          originalForm={originalForm}
          {...field}
        />
      ))}
    </div>
  );
}
