/* oxlint-disable import/max-dependencies -- The application composition root wires each area. */
import { AppShell } from "@astryxdesign/core/AppShell";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { TopNav, TopNavHeading } from "@astryxdesign/core/TopNav";
import { lazy, Suspense, useEffect, useMemo, useState, type ReactElement } from "react";

// oxlint-disable-next-line import/no-unassigned-import -- Vite loads the application stylesheet for its side effect.
import "./App.css";
import { LazyLoadErrorBoundary } from "./LazyLoadErrorBoundary.tsx";
import { useDebouncedQuery } from "./useDebouncedQuery.ts";
import { useCatalogue } from "./useCatalogue.ts";
import { inventoryQueryPath, useCatalogueUrlState } from "./useCatalogueUrlState.ts";
import { useReturnFocus } from "./useReturnFocus.ts";
import {
  useBottleController,
  useCaptureController,
  useLocationController,
  useSiteController,
} from "./useCatalogueControllers.ts";
import {
  locationLabel,
  siteLabel,
  drinkLabel,
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

const InventoryArea = lazy(async () => {
  const module = await import("./InventoryView.tsx");
  return { default: module.InventoryArea };
});

const BottleModal = lazy(async () => {
  const module = await import("./BottleModal.tsx");
  return { default: module.BottleModal };
});
const BottleDetails = lazy(async () => {
  const module = await import("./BottleDetails.tsx");
  return { default: module.BottleDetails };
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

export function Catalogue({
  additionScope,
  authMode,
  authControl,
  getAuthHeaders,
}: CatalogueProps): ReactElement {
  return (
    <CatalogueWorkspace
      key={additionScope}
      additionScope={additionScope}
      authMode={authMode}
      authControl={authControl}
      getAuthHeaders={getAuthHeaders}
    />
  );
}

// oxlint-disable-next-line complexity -- The composition root wires area visibility, permissions, and modal lifecycles.
function CatalogueWorkspace({
  additionScope,
  authMode,
  authControl,
  getAuthHeaders,
}: CatalogueProps): ReactElement {
  const urlState = useCatalogueUrlState();
  const inventoryQuery = useDebouncedQuery(urlState.filter);
  const [captureView, setCaptureView] = useState<"action" | "all">("action");
  const {
    captures,
    inventory,
    capturePage,
    completeMutation,
    items,
    isLoading,
    locations,
    refreshIssues,
    retryRefresh,
    sites,
    summary,
    status,
    setStatus,
    trackPendingCapture,
  } = useCatalogue(getAuthHeaders, {
    area: urlState.area,
    inventoryPath: inventoryQueryPath(urlState, inventoryQuery),
    captureView,
  });
  const writableSites = useMemo(
    () => sites.filter((site) => site.role === "owner" || site.role === "editor"),
    [sites],
  );
  const writableSiteIds = useMemo(
    () => new Set(writableSites.map((site) => site.id)),
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
    inventoryStatus,
    storageLocationIdFilter,
    siteIdFilter,
    varietalFilter,
    setArea,
    setDrinkStatusFilter,
    setFilter,
    setGrouping,
    setInventoryStatus,
    setStorageLocationIdFilter,
    setSiteIdFilter,
    setVarietalFilter,
  } = urlState;
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
    trackPendingCapture,
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
  const isBottleDialogOpen = bottleController.isAddOpen || bottleController.selectedBottle !== null;
  const captureBottleDialogTrigger = useReturnFocus(isBottleDialogOpen, "#add-bottle-trigger");

  const varietalOptions = inventory.page?.facets.grapeVarieties ?? [];
  const locationOptions = useMemo(
    () =>
      locations
        .filter((location) => siteIdFilter === "" || location.siteId === siteIdFilter)
        .map((location) => ({
          value: location.id,
          label: `${siteLabel({ id: location.siteId, name: location.siteName }, sites)} / ${locationLabel(location, locations)}`,
        })),
    [locations, sites, siteIdFilter],
  );
  const siteOptions = useMemo(
    () => sites.map((site) => ({ label: siteLabel(site, sites), value: site.id })),
    [sites],
  );
  const drinkStatusOptions = useMemo(
    () =>
      drinkStatusOrder
        .filter((value) => inventory.page?.facets.drinkStatuses.includes(value) === true)
        .map((value) => ({
          label: drinkLabel(value),
          value,
        })),
    [inventory.page?.facets.drinkStatuses],
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
                <dt>In stock bottles</dt>
                <dd>{summary.inStockBottleCount}</dd>
              </div>
              <div>
                <dt>Drink queue</dt>
                <dd>{summary.drinkQueueBottleCount}</dd>
              </div>
              <div>
                <dt>Captures</dt>
                <dd>{summary.captures.actionable + summary.captures.processing}</dd>
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
                inventoryStatus={inventoryStatus}
                items={items}
                totalCount={inventory.page?.totalCount ?? 0}
                hasMore={inventory.page?.nextPageToken !== null && inventory.page !== null}
                isLoadingMore={inventory.isRefreshing}
                onLoadMore={inventory.loadMore}
                isLoading={isLoading}
                onCreateSite={
                  sites.length === 0 && refreshIssues.length === 0
                    ? () => {
                        setArea("management");
                      }
                    : undefined
                }
                editableSiteIds={writableSiteIds}
                storageLocationIdFilter={storageLocationIdFilter}
                locationOptions={locationOptions}
                siteIdFilter={siteIdFilter}
                siteOptions={siteOptions}
                setSiteIdFilter={setSiteIdFilter}
                locations={locations}
                varietalFilter={varietalFilter}
                varietalOptions={varietalOptions}
                setDrinkStatusFilter={setDrinkStatusFilter}
                setFilter={setFilter}
                setGrouping={setGrouping}
                setInventoryStatus={setInventoryStatus}
                setStorageLocationIdFilter={setStorageLocationIdFilter}
                setVarietalFilter={setVarietalFilter}
                onAddBottle={() => {
                  captureBottleDialogTrigger();
                  bottleController.setIsAddOpen(true);
                }}
                onOpenBottle={(item) => {
                  captureBottleDialogTrigger();
                  void bottleController.openBottleDetails(item);
                }}
              />
            ) : area === "captures" ? (
              <CaptureArea
                captures={captures}
                counts={capturePage.page?.counts ?? summary.captures}
                totalCount={capturePage.page?.totalCount ?? 0}
                hasMore={capturePage.page?.nextPageToken !== null && capturePage.page !== null}
                isLoading={capturePage.isLoading}
                isLoadingMore={capturePage.isRefreshing}
                onLoadMore={capturePage.loadMore}
                view={captureView}
                onViewChange={setCaptureView}
                getAuthHeaders={getAuthHeaders}
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
                getAuthHeaders={getAuthHeaders}
                action={{ kind: "add", form: bottleController.addFormDefaults }}
                isSaving={bottleController.isSaving}
                locations={writableLocations}
                sites={writableSites}
                onClose={bottleController.cancelAddition}
                onSubmit={bottleController.saveBottle}
              />
            ) : null}

            {bottleController.selectedBottle === null ? null : (
              <BottleDetails
                key={bottleController.selectedBottle.id}
                item={bottleController.selectedBottle}
                canEdit={writableSiteIds.has(bottleController.selectedBottle.siteId)}
                getAuthHeaders={getAuthHeaders}
                isSaving={bottleController.isSaving}
                locations={writableLocations}
                sites={writableSites}
                onClose={bottleController.closeBottleDetails}
                onDelete={async () =>
                  bottleController.deleteBottle(bottleController.selectedBottle?.id ?? "")
                }
                onStatusChange={async (bottleStatus) =>
                  bottleController.updateBottle({
                    bottleId: bottleController.selectedBottle?.id ?? "",
                    payload: { status: bottleStatus },
                  })
                }
                onSubmit={bottleController.saveBottleEdit}
              />
            )}
          </Suspense>
        </LazyLoadErrorBoundary>
      </div>
    </AppShell>
  );
}
