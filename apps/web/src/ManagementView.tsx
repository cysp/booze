/* oxlint-disable import/max-dependencies -- Management composes ASTRYX CRUD, progressive lists, and shared workflow controllers. */
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useMemo, useRef, useState, type MouseEvent, type ReactElement } from "react";

import { LocationCreateForm } from "./LocationCreateForm.tsx";
import { DestructiveActionDialog } from "./DestructiveActionDialog.tsx";
import {
  compareLocationPath,
  locationPath,
  locationLabel,
  siteLabel,
  type LocationFormState,
  type LocationItem,
  type SiteFormState,
  type SiteItem,
} from "./inventory-model.ts";
import type { LocationController, SiteController } from "./useCatalogueControllers.ts";
import { useKeyedAsyncOperation } from "./useKeyedAsyncOperation.ts";
import type { NamedResourceActions } from "./useNamedResourceActions.ts";
import { ProgressiveListStatus, PROGRESSIVE_PAGE_SIZE } from "./ProgressiveListStatus.tsx";

export function ManagementArea({
  locationController,
  locations,
  siteController,
  sites,
  writableSiteIds,
  onUseLocation,
}: {
  readonly locationController: LocationController;
  readonly locations: readonly LocationItem[];
  readonly siteController: SiteController;
  readonly sites: readonly SiteItem[];
  readonly writableSiteIds: ReadonlySet<string>;
  readonly onUseLocation: (location: LocationItem) => void;
}): ReactElement {
  return (
    <section className="workspace management-workspace" aria-labelledby="management-title">
      <div className="workspace-header">
        <div>
          <p>Management</p>
          <h2 id="management-title">Sites and locations</h2>
        </div>
      </div>
      <SiteArea
        form={siteController.form}
        resourceActions={siteController.resourceActions}
        sites={sites}
        updateSiteField={siteController.updateField}
        onSaveSite={siteController.save}
      />
      <LocationArea
        form={locationController.form}
        locations={locations}
        resourceActions={locationController.resourceActions}
        sites={sites}
        writableSiteIds={writableSiteIds}
        updateLocationField={locationController.updateField}
        onSaveLocation={locationController.save}
        onUseLocation={onUseLocation}
      />
    </section>
  );
}

function LocationArea({
  form,
  locations,
  resourceActions,
  sites,
  writableSiteIds,
  updateLocationField,
  onSaveLocation,
  onUseLocation,
}: {
  readonly form: LocationFormState;
  readonly locations: readonly LocationItem[];
  readonly resourceActions: NamedResourceActions;
  readonly sites: readonly SiteItem[];
  readonly writableSiteIds: ReadonlySet<string>;
  readonly updateLocationField: (field: keyof LocationFormState, value: string) => void;
  readonly onSaveLocation: () => Promise<boolean>;
  readonly onUseLocation: (location: LocationItem) => void;
}): ReactElement {
  const { beginRename, cancelRename, editor, remove, saveRename, setRename } = resourceActions;
  const deleteTriggerRef = useRef<HTMLButtonElement>(null);
  const sectionHeadingRef = useRef<HTMLHeadingElement>(null);
  const [deletingLocation, setDeletingLocation] = useState<LocationItem | null>(null);
  const [visibleCount, setVisibleCount] = useState(PROGRESSIVE_PAGE_SIZE);
  const sortedLocations = useMemo(
    () => locations.toSorted(compareLocationPath(locations)),
    [locations],
  );
  const visibleLocations = sortedLocations.slice(0, visibleCount);
  const rename = useKeyedAsyncOperation<string>({
    exceptionMessage: "Location was not updated. Check your connection and try again.",
    failureMessage: "Location was not updated. Try again.",
  });

  return (
    <section className="management-section" aria-labelledby="locations-title">
      <div className="section-heading">
        <h3 id="locations-title" ref={sectionHeadingRef} tabIndex={-1}>
          Locations
        </h3>
      </div>
      <LocationCreateForm
        form={form}
        locations={locations}
        sites={sites.filter((site) => writableSiteIds.has(site.id))}
        updateLocationField={updateLocationField}
        onSaveLocation={onSaveLocation}
      />

      {locations.length === 0 ? (
        <EmptyState
          description="Create a site and location before cataloguing the first bottle."
          title="No locations yet"
        />
      ) : (
        <div className="location-grid">
          {visibleLocations.map((location) => (
            <article
              className="location-card"
              data-location-id={location.id}
              key={location.id}
              tabIndex={-1}
            >
              {editor?.id === location.id ? (
                <form
                  className="inline-edit"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (editor.name.trim() === "") {
                      rename.reportError(location.id, "Location name is required.");
                      return;
                    }
                    if (rename.pendingKey !== null) {
                      return;
                    }
                    void rename.run(location.id, saveRename);
                  }}
                >
                  <TextInput
                    autoComplete="off"
                    htmlName="locationName"
                    isRequired
                    label="Location display name"
                    {...(rename.error?.key === location.id
                      ? { status: { message: rename.error.message, type: "error" } }
                      : {})}
                    value={editor.name}
                    onChange={(value: string) => {
                      setRename(value);
                      rename.clearError();
                    }}
                  />
                  <div className="card-actions">
                    <Button
                      isLoading={rename.pendingKey === location.id}
                      label="Save"
                      type="submit"
                      variant="primary"
                    />
                    <Button label="Cancel" variant="ghost" onClick={cancelRename} />
                  </div>
                </form>
              ) : (
                <>
                  <div>
                    <h3>{locationLabel(location, locations)}</h3>
                    <p>{location.siteName}</p>
                  </div>
                  <dl>
                    <div>
                      <dt>Available</dt>
                      <dd>{location.bottleCount} bottles</dd>
                    </div>
                  </dl>
                  {writableSiteIds.has(location.siteId) ? (
                    <div className="card-actions">
                      <Button
                        label="Use for bottle"
                        onClick={() => {
                          onUseLocation(location);
                        }}
                      />
                      <Button
                        label="Edit"
                        variant="ghost"
                        onClick={() => {
                          beginRename(location.id, location.name);
                        }}
                      />
                      <Button
                        label="Delete"
                        variant="destructive"
                        onClick={(event: MouseEvent<HTMLButtonElement>) => {
                          deleteTriggerRef.current = event.currentTarget;
                          setDeletingLocation(location);
                        }}
                      />
                    </div>
                  ) : null}
                </>
              )}
            </article>
          ))}
        </div>
      )}
      <ProgressiveListStatus
        getRevealFocusTarget={(firstRevealedIndex) => {
          const location = sortedLocations[firstRevealedIndex];
          return location === undefined ? null : locationCard(location.id);
        }}
        itemLabel="locations"
        totalCount={sortedLocations.length}
        visibleCount={visibleLocations.length}
        onReveal={setVisibleCount}
      />
      {deletingLocation === null ? null : (
        <DestructiveActionDialog
          actionLabel="Delete location"
          description={`Bottles in ${locationPath(deletingLocation, locations)} will remain in ${deletingLocation.siteName} without a storage location. This action cannot be undone.`}
          fallbackFocus={() => sectionHeadingRef.current}
          failureMessage="Location was not deleted. Try again."
          isOpen
          returnFocusRef={deleteTriggerRef}
          title={`Delete ${deletingLocation.name}?`}
          onAction={async () => remove(deletingLocation.id)}
          onOpenChange={(isOpen: boolean) => {
            if (!isOpen) {
              setDeletingLocation(null);
            }
          }}
        />
      )}
    </section>
  );
}

function SiteArea({
  form,
  resourceActions,
  sites,
  updateSiteField,
  onSaveSite,
}: {
  readonly form: SiteFormState;
  readonly resourceActions: NamedResourceActions;
  readonly sites: readonly SiteItem[];
  readonly updateSiteField: (field: keyof SiteFormState, value: string) => void;
  readonly onSaveSite: () => Promise<boolean>;
}): ReactElement {
  const { beginRename, cancelRename, editor, remove, saveRename, setRename } = resourceActions;
  const deleteTriggerRef = useRef<HTMLButtonElement>(null);
  const sectionHeadingRef = useRef<HTMLHeadingElement>(null);
  const [deletingSite, setDeletingSite] = useState<SiteItem | null>(null);
  const [visibleCount, setVisibleCount] = useState(PROGRESSIVE_PAGE_SIZE);
  const visibleSites = sites.slice(0, visibleCount);
  const [isSaving, setIsSaving] = useState(false);
  const isSavingRef = useRef(false);
  const [siteError, setSiteError] = useState<string | null>(null);
  const rename = useKeyedAsyncOperation<string>({
    exceptionMessage: "Site was not updated. Check your connection and try again.",
    failureMessage: "Site was not updated. Try again.",
  });

  async function saveSite(): Promise<void> {
    if (isSavingRef.current) {
      return;
    }
    isSavingRef.current = true;
    setIsSaving(true);
    setSiteError(null);
    try {
      const saved = await onSaveSite();
      if (!saved) {
        setSiteError("Site was not saved. Try again.");
      }
    } catch {
      setSiteError("Site was not saved. Check your connection and try again.");
    } finally {
      isSavingRef.current = false;
      setIsSaving(false);
    }
  }

  return (
    <section className="management-section" aria-labelledby="sites-title">
      <div className="section-heading">
        <h3 id="sites-title" ref={sectionHeadingRef} tabIndex={-1}>
          Sites
        </h3>
      </div>
      <form
        className="form-stack"
        onSubmit={(event) => {
          event.preventDefault();
          if (form.site.trim() === "") {
            setSiteError("Site name is required.");
            return;
          }
          if (isSavingRef.current) {
            return;
          }
          void saveSite();
        }}
      >
        <TextInput
          autoComplete="organization"
          htmlName="siteName"
          isRequired
          label="Site"
          placeholder="Home"
          {...(siteError === null ? {} : { status: { message: siteError, type: "error" } })}
          value={form.site}
          onChange={(value: string) => {
            updateSiteField("site", value);
            setSiteError(null);
          }}
        />
        <Button isLoading={isSaving} label="Save site" type="submit" variant="primary" />
      </form>

      {sites.length === 0 ? (
        <EmptyState
          description="Create a site before cataloguing bottles or locations."
          title="No sites yet"
        />
      ) : (
        <div className="location-grid">
          {visibleSites.map((site) => (
            <article className="location-card" data-site-id={site.id} key={site.id} tabIndex={-1}>
              {editor?.id === site.id ? (
                <form
                  className="inline-edit"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (editor.name.trim() === "") {
                      rename.reportError(site.id, "Site name is required.");
                      return;
                    }
                    if (rename.pendingKey !== null) {
                      return;
                    }
                    void rename.run(site.id, saveRename);
                  }}
                >
                  <TextInput
                    autoComplete="organization"
                    htmlName="siteName"
                    isRequired
                    label="Site display name"
                    {...(rename.error?.key === site.id
                      ? { status: { message: rename.error.message, type: "error" } }
                      : {})}
                    value={editor.name}
                    onChange={(value: string) => {
                      setRename(value);
                      rename.clearError();
                    }}
                  />
                  <div className="card-actions">
                    <Button
                      isLoading={rename.pendingKey === site.id}
                      label="Save"
                      type="submit"
                      variant="primary"
                    />
                    <Button label="Cancel" variant="ghost" onClick={cancelRename} />
                  </div>
                </form>
              ) : (
                <>
                  <div>
                    <h3>{siteLabel(site, sites)}</h3>
                    <p>
                      <Badge label={site.role} variant="neutral" />
                    </p>
                  </div>
                  <dl>
                    <div>
                      <dt>Available</dt>
                      <dd>{site.bottleCount} bottles</dd>
                    </div>
                    <div>
                      <dt>Locations</dt>
                      <dd>{site.locationCount}</dd>
                    </div>
                  </dl>
                  {site.role === "owner" ? (
                    <div className="card-actions">
                      <Button
                        label="Edit"
                        onClick={() => {
                          beginRename(site.id, site.name);
                        }}
                      />
                      <Button
                        label="Delete"
                        variant="destructive"
                        onClick={(event: MouseEvent<HTMLButtonElement>) => {
                          deleteTriggerRef.current = event.currentTarget;
                          setDeletingSite(site);
                        }}
                      />
                    </div>
                  ) : null}
                </>
              )}
            </article>
          ))}
        </div>
      )}
      <ProgressiveListStatus
        getRevealFocusTarget={(firstRevealedIndex) => {
          const site = sites[firstRevealedIndex];
          return site === undefined ? null : siteCard(site.id);
        }}
        itemLabel="sites"
        totalCount={sites.length}
        visibleCount={visibleSites.length}
        onReveal={setVisibleCount}
      />
      {deletingSite === null ? null : (
        <DestructiveActionDialog
          actionLabel="Delete site"
          description="This permanently removes the site, its bottles, wine vintages, locations, and membership records. This action cannot be undone."
          fallbackFocus={() => sectionHeadingRef.current}
          failureMessage="Site was not deleted. Try again."
          isOpen
          returnFocusRef={deleteTriggerRef}
          title={`Delete ${deletingSite.name}?`}
          onAction={async () => remove(deletingSite.id)}
          onOpenChange={(isOpen: boolean) => {
            if (!isOpen) {
              setDeletingSite(null);
            }
          }}
        />
      )}
    </section>
  );
}

function locationCard(locationId: string): HTMLElement | null {
  return (
    [...document.querySelectorAll<HTMLElement>("[data-location-id]")].find(
      (element) => element.dataset["locationId"] === locationId,
    ) ?? null
  );
}

function siteCard(siteId: string): HTMLElement | null {
  return (
    [...document.querySelectorAll<HTMLElement>("[data-site-id]")].find(
      (element) => element.dataset["siteId"] === siteId,
    ) ?? null
  );
}
