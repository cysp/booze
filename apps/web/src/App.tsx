/* oxlint-disable import/max-dependencies -- The application composition root wires each area. */
import { AppShell } from "@astryxdesign/core/AppShell";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { TopNav, TopNavHeading } from "@astryxdesign/core/TopNav";
import { lazy, Suspense, useEffect, useMemo, type ReactElement } from "react";

// oxlint-disable-next-line import/no-unassigned-import -- Vite loads the application stylesheet for its side effect.
import "./App.css";
import { parseGrapeVarieties } from "./bottle-metadata.ts";
import { InventoryArea } from "./InventoryView.tsx";
import { LazyLoadErrorBoundary } from "./LazyLoadErrorBoundary.tsx";
import { useCatalogue } from "./useCatalogue.ts";
import { useCatalogueUrlState } from "./useCatalogueUrlState.ts";
import { useReturnFocus } from "./useReturnFocus.ts";
import {
  useBottleController,
  useCaptureController,
  useLocationController,
  useSiteController,
} from "./useCatalogueControllers.ts";
import {
  awardSummary,
  criticReviewSummary,
  drinkLabel,
  isDrinkQueueItem,
  storageLocationPath,
  type AuthMode,
  type InventoryItem,
} from "./inventory-model.ts";

type AppProps = {
  readonly authMode: AuthMode;
};

type CatalogueProps = {
  readonly additionScope: string;
  readonly authMode: AuthMode;
  readonly authControl: ReactElement;
  readonly getAuthHeaders: () => Promise<Record<string, string>>;
};

const drinkStatusOrder = [
  "drink-now",
  "drink-soon",
  "hold",
  "past-window",
  "unknown",
] satisfies readonly InventoryItem["drinkStatus"][];

const BottleModal = lazy(async () => {
  const module = await import("./BottleModal.tsx");
  return { default: module.BottleModal };
});

const CaptureArea = lazy(async () => {
  const module = await import("./CaptureView.tsx");
  return { default: module.CaptureArea };
});

const ManagementArea = lazy(async () => {
  const module = await import("./ManagementView.tsx");
  return { default: module.ManagementArea };
});

async function getDevelopmentAuthHeaders(): Promise<Record<string, string>> {
  return { "x-dev-user": "local-browser" };
}

async function setDevelopmentAuthCookie(): Promise<void> {
  if (!("cookieStore" in window)) {
    return;
  }

  await window.cookieStore.set({
    name: "booze_dev_user",
    path: "/",
    sameSite: "lax",
    value: "local-browser",
  });
}

export function App({ authMode }: AppProps): ReactElement {
  useEffect(() => {
    if (authMode === "development") {
      void setDevelopmentAuthCookie();
    }
  }, [authMode]);

  return (
    <Catalogue
      additionScope="development"
      authControl={<></>}
      authMode={authMode}
      getAuthHeaders={getDevelopmentAuthHeaders}
    />
  );
}

function grapeVarieties(item: InventoryItem): readonly string[] {
  return item.grapeVarieties === null ? [] : parseGrapeVarieties(item.grapeVarieties);
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter((value) => value !== ""))].toSorted((left, right) =>
    left.localeCompare(right),
  );
}

export function Catalogue({
  additionScope,
  authMode,
  authControl,
  getAuthHeaders,
}: CatalogueProps): ReactElement {
  const {
    captures,
    wines,
    completeMutation,
    items,
    isLoading,
    locations,
    refreshIssues,
    retryRefresh,
    sites,
    status,
    setStatus,
  } = useCatalogue(getAuthHeaders);
  const writableSites = useMemo(
    () => sites.filter((site) => site.role === "owner" || site.role === "editor"),
    [sites],
  );
  const writableSiteIds = useMemo(
    () => new Set(writableSites.map((site) => site.siteId)),
    [writableSites],
  );
  const writableLocations = useMemo(
    () => locations.filter((location) => writableSiteIds.has(location.siteId)),
    [locations, writableSiteIds],
  );
  const {
    area,
    drinkStatusFilter,
    filter,
    grouping,
    locationFilter,
    varietalFilter,
    setArea,
    setDrinkStatusFilter,
    setFilter,
    setGrouping,
    setLocationFilter,
    setVarietalFilter,
  } = useCatalogueUrlState();
  const bottleController = useBottleController({
    additionScope,
    completeMutation,
    getAuthHeaders,
    locations,
    setStatus,
    writableSites,
  });
  const captureController = useCaptureController({
    additionScope,
    completeMutation,
    getAuthHeaders,
    setStatus,
    writableSites,
  });
  const locationController = useLocationController({
    completeMutation,
    getAuthHeaders,
    setStatus,
    writableSites,
  });
  const siteController = useSiteController({
    completeMutation,
    getAuthHeaders,
    setStatus,
  });
  const drinkItems = useMemo(() => items.filter((item) => isDrinkQueueItem(item)), [items]);
  const isBottleDialogOpen =
    bottleController.isAddOpen ||
    (bottleController.editingBottle !== null && bottleController.editingForm !== null);
  const captureBottleDialogTrigger = useReturnFocus(isBottleDialogOpen, "#add-bottle-trigger");

  const listedItems = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return items.filter(
      (item) =>
        (needle === "" ||
          [
            item.site,
            storageLocationPath(item, locations),
            item.position,
            item.wineryName,
            item.brandName,
            item.displayName,
            item.vintageLabel,
            item.vintageYear?.toString() ?? null,
            item.grapeVarieties,
            item.country,
            item.region,
            item.appellation,
            item.classification,
            item.wineType,
            item.wineColor,
            item.alcoholPercent,
            item.bottleVolumeMl,
            item.addressQualification,
            item.barcode,
            item.lotCode,
            item.description,
            item.drinkingAdvice,
            item.labelText,
            item.wineNotes,
            item.bottleNotes,
            criticReviewSummary(item),
            awardSummary(item),
          ]
            .filter((value) => value !== null)
            .some((value) => value.toLowerCase().includes(needle))) &&
        (varietalFilter === "" || grapeVarieties(item).includes(varietalFilter)) &&
        (locationFilter === "" || storageLocationPath(item, locations) === locationFilter) &&
        (drinkStatusFilter === "" || item.drinkStatus === drinkStatusFilter),
    );
  }, [drinkStatusFilter, filter, items, locationFilter, locations, varietalFilter]);

  const varietalOptions = useMemo(
    () => uniqueSorted(items.flatMap((item) => grapeVarieties(item))),
    [items],
  );
  const locationOptions = useMemo(
    () => uniqueSorted(items.map((item) => storageLocationPath(item, locations))),
    [items, locations],
  );
  const drinkStatusOptions = useMemo(
    () =>
      drinkStatusOrder
        .filter((value) => items.some((item) => item.drinkStatus === value))
        .map((value) => ({
          label: drinkLabel(value),
          value,
        })),
    [items],
  );

  return (
    <AppShell
      contentPadding={0}
      height="auto"
      variant="elevated"
      topNav={
        <TopNav
          endContent={
            <div className="header-actions">
              {authMode === "development" ? <Badge label="Local" variant="info" /> : null}
              {authControl}
            </div>
          }
          heading={
            <TopNavHeading
              heading="Booze"
              logo={<img alt="" className="brand-logo" height="36" src="/favicon.svg" width="36" />}
              superheading="Wine cellar"
            />
          }
          label="Booze navigation"
        />
      }
    >
      <div className="app-content">
        <Card padding={5}>
          <section className="hero-band" aria-label="Cellar summary">
            <div className="hero-copy">
              <p aria-live="polite" role="status">
                {status}
              </p>
              <h1>Find the right bottle without digging through boxes.</h1>
            </div>
            <dl>
              <div>
                <dt>Bottles</dt>
                <dd>{items.length}</dd>
              </div>
              <div>
                <dt>Drink queue</dt>
                <dd>{drinkItems.length}</dd>
              </div>
              <div>
                <dt>Captures</dt>
                <dd>{captures.filter((capture) => capture.status !== "imported").length}</dd>
              </div>
            </dl>
          </section>
        </Card>

        {refreshIssues.map((issue) => (
          <Banner
            key={issue.collection}
            aria-label={issue.message}
            endContent={
              <Button
                clickAction={async () => retryRefresh(issue.collection)}
                label="Retry refresh"
                variant="ghost"
              />
            }
            role="alert"
            status="warning"
            title={issue.message}
          />
        ))}

        <TabList
          hasDivider
          layout="fill"
          value={area}
          onChange={(value: string) => {
            if (value === "inventory" || value === "captures" || value === "management") {
              setArea(value);
            }
          }}
        >
          <Tab label="Inventory" value="inventory" />
          <Tab label="Capture" value="captures" />
          <Tab label="Storage" value="management" />
        </TabList>

        <LazyLoadErrorBoundary
          description="Reload the latest application files and try this workspace again."
          key={area}
          title="Cellar workspace could not be loaded"
        >
          <Suspense fallback={<p role="status">Loading cellar workspace…</p>}>
            {area === "inventory" ? (
              <InventoryArea
                drinkStatusFilter={drinkStatusFilter}
                drinkStatusOptions={drinkStatusOptions}
                filter={filter}
                grouping={grouping}
                items={listedItems}
                isLoading={isLoading}
                onCreateSite={
                  sites.length === 0 && refreshIssues.length === 0
                    ? () => {
                        setArea("management");
                      }
                    : undefined
                }
                editableSiteIds={writableSiteIds}
                locationFilter={locationFilter}
                locationOptions={locationOptions}
                locations={locations}
                varietalFilter={varietalFilter}
                varietalOptions={varietalOptions}
                setDrinkStatusFilter={setDrinkStatusFilter}
                setFilter={setFilter}
                setGrouping={setGrouping}
                setLocationFilter={setLocationFilter}
                setVarietalFilter={setVarietalFilter}
                onAddBottle={() => {
                  captureBottleDialogTrigger();
                  bottleController.setIsAddOpen(true);
                }}
                onEditBottle={(item) => {
                  captureBottleDialogTrigger();
                  bottleController.openBottleEditor(item);
                }}
              />
            ) : area === "captures" ? (
              <CaptureArea
                captures={captures}
                wines={wines}
                form={captureController.captureForm}
                isSaving={captureController.isSaving}
                locations={writableLocations}
                sites={writableSites}
                writableSiteIds={writableSiteIds}
                setForm={captureController.setCaptureForm}
                onDelete={captureController.deleteCapture}
                onImport={captureController.importCapture}
                onSaveReview={captureController.saveCaptureReview}
                onRetry={captureController.retryCapture}
                onSubmit={captureController.submitCapture}
                onCancelAddition={captureController.cancelAddition}
              />
            ) : (
              <ManagementArea
                locationController={locationController}
                locations={locations}
                siteController={siteController}
                sites={sites}
                writableSiteIds={writableSiteIds}
                onUseLocation={(location) => {
                  captureBottleDialogTrigger();
                  bottleController.useLocation(location);
                }}
              />
            )}

            {bottleController.isAddOpen ? (
              <BottleModal
                wines={wines}
                form={bottleController.addFormDefaults}
                isSaving={bottleController.isSaving}
                locations={writableLocations}
                sites={writableSites}
                title="Add bottle"
                onClose={bottleController.cancelAddition}
                onSubmit={bottleController.saveBottle}
              />
            ) : null}

            {bottleController.editingBottle === null ||
            bottleController.editingForm === null ? null : (
              <BottleModal
                wines={wines}
                key={bottleController.editingBottle.bottleId}
                form={bottleController.editingForm}
                isSaving={bottleController.isSaving}
                item={bottleController.editingBottle}
                locations={writableLocations}
                sites={writableSites}
                title="Edit bottle"
                onClose={() => {
                  bottleController.setEditingBottle(null);
                }}
                onDelete={async () => {
                  return bottleController.deleteBottle(
                    bottleController.editingBottle?.bottleId ?? "",
                  );
                }}
                onMarkConsumed={async () => {
                  const updated = await bottleController.updateBottle({
                    bottleId: bottleController.editingBottle?.bottleId ?? "",
                    payload: { status: "consumed" },
                  });
                  if (updated) {
                    bottleController.setEditingBottle(null);
                  }
                  return updated;
                }}
                onSubmit={bottleController.saveBottleEdit}
              />
            )}
          </Suspense>
        </LazyLoadErrorBoundary>
      </div>
    </AppShell>
  );
}
