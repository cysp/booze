import { Button } from "@astryxdesign/core/Button";
import { Selector } from "@astryxdesign/core/Selector";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";

import {
  compareLocationPath,
  locationLabel,
  siteLabel,
  type LocationFormState,
  type LocationItem,
  type SiteItem,
} from "./inventory-model.ts";

type LocationCreateFormProps = {
  readonly form: LocationFormState;
  readonly locations: readonly LocationItem[];
  readonly sites: readonly SiteItem[];
  readonly updateLocationField: (field: keyof LocationFormState, value: string) => void;
  readonly onSaveLocation: () => Promise<boolean>;
};

export function LocationCreateForm({
  form,
  locations,
  sites,
  updateLocationField,
  onSaveLocation,
}: LocationCreateFormProps): ReactElement {
  const [isSaving, setIsSaving] = useState(false);
  const isSavingRef = useRef(false);
  const [siteError, setSiteError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const siteLocations = useMemo(
    () =>
      locations
        .filter((location) => location.siteId === form.siteId)
        .toSorted(compareLocationPath(locations)),
    [form.siteId, locations],
  );
  const parentLocationId = siteLocations.some((location) => location.id === form.parentLocationId)
    ? form.parentLocationId
    : "";

  useEffect(() => {
    if (form.parentLocationId !== parentLocationId) {
      updateLocationField("parentLocationId", parentLocationId);
    }
  }, [form.parentLocationId, parentLocationId, updateLocationField]);

  async function saveLocation(): Promise<void> {
    if (isSavingRef.current) {
      return;
    }
    isSavingRef.current = true;
    setIsSaving(true);
    try {
      const saved = await onSaveLocation();
      if (!saved) {
        setNameError("Location was not saved. Try again.");
      }
    } catch {
      setNameError("Location was not saved. Check your connection and try again.");
    } finally {
      isSavingRef.current = false;
      setIsSaving(false);
    }
  }

  return (
    <form
      className="form-stack"
      onSubmit={(event) => {
        event.preventDefault();
        const nextSiteError = form.siteId === "" ? "Site is required." : null;
        const nextNameError = form.location.trim() === "" ? "Location name is required." : null;
        setSiteError(nextSiteError);
        setNameError(nextNameError);
        if (nextSiteError !== null || nextNameError !== null || isSavingRef.current) {
          return;
        }
        void saveLocation();
      }}
    >
      <div className="field-row">
        <Selector
          htmlName="siteId"
          isRequired
          label="Site"
          options={sites.map((site) => ({ label: siteLabel(site, sites), value: site.id }))}
          placeholder={sites.length === 0 ? "Create a site first" : "Select site"}
          {...(siteError === null ? {} : { status: { message: siteError, type: "error" } })}
          value={form.siteId}
          onChange={(value: string) => {
            const site = sites.find((candidate) => candidate.id === value);
            updateLocationField("siteId", site?.id ?? "");
            updateLocationField("site", site?.name ?? "");
            updateLocationField("parentLocationId", "");
            setSiteError(null);
          }}
        />
        <Selector
          hasClear
          htmlName="parentLocationId"
          description="Choose a containing location only when this is a smaller place inside it."
          {...(form.siteId === "" ? { disabledMessage: "Select a site first." } : {})}
          isDisabled={form.siteId === ""}
          label="Inside"
          options={siteLocations.map((location) => ({
            label: locationLabel(location, locations),
            value: location.id,
          }))}
          placeholder="Top level"
          value={parentLocationId}
          onChange={(value: string | null) => {
            updateLocationField("parentLocationId", value ?? "");
          }}
        />
      </div>
      <TextInput
        autoComplete="off"
        htmlName="location"
        isRequired
        label="New location"
        placeholder="Left rack"
        {...(nameError === null ? {} : { status: { message: nameError, type: "error" } })}
        value={form.location}
        onChange={(value: string) => {
          updateLocationField("location", value);
          setNameError(null);
        }}
      />
      <Button isLoading={isSaving} label="Save location" type="submit" variant="primary" />
    </form>
  );
}
