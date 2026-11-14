import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Selector } from "@astryxdesign/core/Selector";
import { TextInput } from "@astryxdesign/core/TextInput";
import type { ReactElement } from "react";

import {
  bottleTitle,
  bottleFacts,
  drinkLabel,
  drinkWindow,
  grapeSummary,
  storageLocationPath,
  siteLabel,
  locationLabel,
  wineOrigin,
  type InventoryGrouping,
  type InventorySummaryItem,
  type LocationItem,
} from "./inventory-model.ts";
import { ReadPageStatus } from "./ReadPageStatus.tsx";

type InventoryAreaProps = {
  readonly drinkStatusFilter: string;
  readonly drinkStatusOptions: readonly SelectOption[];
  readonly filter: string;
  readonly grouping: InventoryGrouping;
  readonly items: readonly InventorySummaryItem[];
  readonly isLoading?: boolean;
  readonly totalCount?: number;
  readonly hasMore?: boolean;
  readonly isLoadingMore?: boolean;
  readonly onLoadMore?: () => Promise<unknown>;
  readonly onCreateSite?: (() => void) | undefined;
  readonly editableSiteIds: ReadonlySet<string>;
  readonly storageLocationIdFilter: string;
  readonly siteIdFilter: string;
  readonly siteOptions: readonly SelectOption[];
  readonly setSiteIdFilter: (value: string) => void;
  readonly locationOptions: readonly SelectOption[];
  readonly locations: readonly LocationItem[];
  readonly varietalFilter: string;
  readonly varietalOptions: readonly string[];
  readonly setDrinkStatusFilter: (value: string) => void;
  readonly setFilter: (value: string) => void;
  readonly setGrouping: (value: InventoryGrouping) => void;
  readonly setStorageLocationIdFilter: (value: string) => void;
  readonly setVarietalFilter: (value: string) => void;
  readonly onAddBottle: () => void;
  readonly onEditBottle: (item: InventorySummaryItem) => void;
};

type SelectOption = {
  readonly label: string;
  readonly value: string;
};

type WineRow = {
  readonly bottleCount: number;
  readonly bottles: readonly InventorySummaryItem[];
  readonly item: InventorySummaryItem;
};

export function InventoryArea({
  drinkStatusFilter,
  drinkStatusOptions,
  filter,
  grouping,
  items,
  isLoading = false,
  totalCount = items.length,
  hasMore = false,
  isLoadingMore = false,
  onLoadMore = async () => {
    /* No further pages for standalone inventory renderers. */
  },
  onCreateSite,
  editableSiteIds,
  storageLocationIdFilter,
  siteIdFilter,
  siteOptions,
  setSiteIdFilter,
  locationOptions,
  locations,
  varietalFilter,
  varietalOptions,
  setDrinkStatusFilter,
  setFilter,
  setGrouping,
  setStorageLocationIdFilter,
  setVarietalFilter,
  onAddBottle,
  onEditBottle,
}: InventoryAreaProps): ReactElement {
  return (
    <section className="workspace" aria-labelledby="inventory-title">
      <div className="workspace-header">
        <div>
          <p>Inventory</p>
          <h2 id="inventory-title">Browse bottles</h2>
        </div>
        {editableSiteIds.size === 0 ? null : (
          <Button
            id="add-bottle-trigger"
            label="Add bottle"
            variant="primary"
            onClick={onAddBottle}
          />
        )}
      </div>

      <div className="inventory-controls">
        <SegmentedControl
          label="Inventory grouping"
          value={grouping}
          onChange={(value: string) => {
            if (value === "winery" || value === "storage") {
              setGrouping(value);
            }
          }}
        >
          <SegmentedControlItem label="Winery" value="winery" />
          <SegmentedControlItem label="Storage" value="storage" />
        </SegmentedControl>
      </div>

      <TextInput
        autoComplete="off"
        hasClear
        htmlName="inventorySearch"
        label="Search bottles"
        placeholder="Site, location, wine, or grape"
        startIcon="search"
        value={filter}
        onChange={setFilter}
      />

      <div className="filter-row" aria-label="Inventory filters">
        <Selector
          hasClear
          htmlName="varietalFilter"
          label="Varietal"
          options={varietalOptions.map((varietal) => ({ label: varietal, value: varietal }))}
          placeholder="All varietals"
          value={varietalFilter}
          onChange={(value: string | null) => {
            setVarietalFilter(value ?? "");
          }}
        />
        <Selector
          hasClear
          htmlName="siteIdFilter"
          label="Site"
          options={[...siteOptions]}
          placeholder="All sites"
          value={siteIdFilter}
          onChange={(value: string | null) => {
            setSiteIdFilter(value ?? "");
          }}
        />
        <Selector
          hasClear
          htmlName="storageLocationIdFilter"
          label="Location"
          options={[...locationOptions]}
          placeholder="All locations"
          value={storageLocationIdFilter}
          onChange={(value: string | null) => {
            setStorageLocationIdFilter(value ?? "");
          }}
        />
        <Selector
          hasClear
          htmlName="drinkStatusFilter"
          label="Drink status"
          options={[...drinkStatusOptions]}
          placeholder="All statuses"
          value={drinkStatusFilter}
          onChange={(value: string | null) => {
            setDrinkStatusFilter(value ?? "");
          }}
        />
      </div>

      {isLoading ? (
        <p role="status">Loading bottles…</p>
      ) : items.length === 0 ? (
        <EmptyState
          actions={
            onCreateSite === undefined ? undefined : (
              <Button label="Create your first site" variant="primary" onClick={onCreateSite} />
            )
          }
          description={
            onCreateSite === undefined
              ? "Catalogue bottles with drink windows and locations, or clear the active filters."
              : "Create a site such as Home to start cataloguing your bottles. Storage locations are optional."
          }
          title={onCreateSite === undefined ? "No matching bottles" : "Start your cellar"}
        />
      ) : grouping === "winery" ? (
        <WineryInventory
          editableSiteIds={editableSiteIds}
          items={items}
          locations={locations}
          onEditBottle={onEditBottle}
        />
      ) : (
        <StorageInventory
          editableSiteIds={editableSiteIds}
          items={items}
          locations={locations}
          onEditBottle={onEditBottle}
        />
      )}
      <ReadPageStatus
        getRevealFocusTarget={(firstRevealedIndex) => {
          const item = items[firstRevealedIndex];
          return item === undefined ? null : inventoryCardForBottle(item.id);
        }}
        itemLabel="bottles"
        totalCount={totalCount}
        visibleCount={items.length}
        hasMore={hasMore}
        isLoading={isLoadingMore}
        onLoadMore={onLoadMore}
      />
    </section>
  );
}

function WineryInventory({
  editableSiteIds,
  items,
  locations,
  onEditBottle,
}: {
  readonly editableSiteIds: ReadonlySet<string>;
  readonly items: readonly InventorySummaryItem[];
  readonly locations: readonly LocationItem[];
  readonly onEditBottle: (item: InventorySummaryItem) => void;
}): ReactElement {
  const groups = groupBy(
    items,
    (item) =>
      JSON.stringify(["winery", item.wineryId, item.wineryId === null ? item.siteId : null]),
    (item) => item.wineryName || "Unknown winery",
    (item) => item.wineryId ?? item.siteId,
  );
  return (
    <div className="inventory-groups">
      {groups.map((group) => (
        <section className="inventory-group" key={group.key}>
          <div className="group-heading">
            <h3>{group.label}</h3>
            <span>{wineGroupSummary(group.items)}</span>
          </div>
          <div className="inventory-list">
            {wineRows(group.items).map((row) => (
              <WineCard
                editable={editableSiteIds.has(row.item.siteId)}
                key={row.item.wineVintageId}
                locations={locations}
                row={row}
                onEditBottle={onEditBottle}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function StorageInventory({
  editableSiteIds,
  items,
  locations,
  onEditBottle,
}: {
  readonly editableSiteIds: ReadonlySet<string>;
  readonly items: readonly InventorySummaryItem[];
  readonly locations: readonly LocationItem[];
  readonly onEditBottle: (item: InventorySummaryItem) => void;
}): ReactElement {
  const sites = [
    ...new Map(
      items.map((item) => [item.siteId, { id: item.siteId, name: item.siteName }]),
    ).values(),
  ];
  const siteGroups = groupBy(
    items,
    (item) => item.siteId,
    (item) => siteLabel({ id: item.siteId, name: item.siteName }, sites),
  );
  return (
    <div className="inventory-groups">
      {siteGroups.map((siteGroup) => (
        <section className="inventory-group" key={siteGroup.key}>
          <div className="group-heading">
            <h3>{siteGroup.label}</h3>
            <span>{wineGroupSummary(siteGroup.items)}</span>
          </div>
          {groupBy(
            siteGroup.items,
            (item) => JSON.stringify(["location", item.storageLocationId]),
            (item) => {
              const location = locations.find(
                (candidate) => candidate.id === item.storageLocationId,
              );
              return location === undefined
                ? storageLocationPath(item, locations)
                : locationLabel(location, locations);
            },
            (item) => item.storageLocationId ?? item.siteId,
          ).map((locationGroup) => (
            <section className="nested-group" key={`${siteGroup.key}-${locationGroup.key}`}>
              <div className="nested-heading">
                <h4>{locationGroup.label}</h4>
                <span>{wineGroupSummary(locationGroup.items)}</span>
              </div>
              <div className="inventory-list">
                {wineRows(locationGroup.items).map((row) => (
                  <WineCard
                    editable={editableSiteIds.has(row.item.siteId)}
                    key={row.item.wineVintageId}
                    locations={locations}
                    row={row}
                    onEditBottle={onEditBottle}
                  />
                ))}
              </div>
            </section>
          ))}
        </section>
      ))}
    </div>
  );
}

function groupBy(
  items: readonly InventorySummaryItem[],
  keyForItem: (item: InventorySummaryItem) => string,
  labelForItem: (item: InventorySummaryItem) => string,
  disambiguatorForItem: (item: InventorySummaryItem) => string = keyForItem,
): readonly {
  readonly key: string;
  readonly label: string;
  readonly items: readonly InventorySummaryItem[];
}[] {
  const groups = new Map<string, InventorySummaryItem[]>();
  for (const item of items) {
    const key = keyForItem(item);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [item]);
    } else {
      group.push(item);
    }
  }
  return [...groups.entries()]
    .map(([key, groupItems]) => ({
      key,
      label: groupItems[0] === undefined ? key : labelForItem(groupItems[0]),
      items: groupItems,
    }))
    .map((group, _, all) => ({
      ...group,
      label: all.some((candidate) => candidate.key !== group.key && candidate.label === group.label)
        ? `${group.label} (${group.items[0] === undefined ? group.key : disambiguatorForItem(group.items[0])})`
        : group.label,
    }))
    .toSorted((left, right) => left.label.localeCompare(right.label));
}

function wineRows(items: readonly InventorySummaryItem[]): readonly WineRow[] {
  const groups = new Map<string, InventorySummaryItem[]>();
  for (const item of items) {
    const group = groups.get(item.wineVintageId);
    if (group === undefined) {
      groups.set(item.wineVintageId, [item]);
    } else {
      group.push(item);
    }
  }
  const rows: WineRow[] = [];
  for (const bottles of groups.values()) {
    const item = bottles[0];
    if (item === undefined) {
      continue;
    }
    rows.push({
      bottleCount: bottles.length,
      bottles,
      item,
    });
  }
  return rows.toSorted((left, right) =>
    bottleTitle(left.item).localeCompare(bottleTitle(right.item)),
  );
}

function wineGroupSummary(items: readonly InventorySummaryItem[]): string {
  return `${countLabel(items.length, "bottle")} shown`;
}

function countLabel(count: number, singular: string): string {
  return count === 1 ? `${count} ${singular}` : `${count} ${singular}s`;
}

function WineCard({
  editable,
  locations,
  row,
  onEditBottle,
}: {
  readonly editable: boolean;
  readonly locations: readonly LocationItem[];
  readonly row: WineRow;
  readonly onEditBottle: (item: InventorySummaryItem) => void;
}): ReactElement {
  const item = row.item;
  return (
    <article
      className={`bottle-card drink-${item.drinkStatus}`}
      data-inventory-bottle-ids={row.bottles.map((bottle) => bottle.id).join("\n")}
      tabIndex={-1}
    >
      <div className="bottle-row-main">
        <div className="bottle-row-title">
          <h3>{bottleTitle(item)}</h3>
          <p>{wineSubtitle(row, locations)}</p>
        </div>
        <Badge label={drinkLabel(item.drinkStatus)} variant={drinkStatusBadge(item.drinkStatus)} />
        {row.bottleCount === 1 ? null : (
          <span className="bottle-count">{row.bottleCount} bottles shown</span>
        )}
      </div>
      <p className="bottle-row-meta">
        {[grapeSummary(item), wineOrigin(item), bottleFacts(item), `Drink ${drinkWindow(item)}`]
          .filter((value) => value !== "")
          .join(" - ")}
      </p>
      {editable && row.bottleCount > 1 ? (
        <details className="bottle-options">
          <summary>Choose a bottle to edit, move, or mark drunk</summary>
          <ul>
            {row.bottles.map((bottle, index) => (
              <li key={bottle.id}>
                <div>
                  <p>{`Bottle ${index + 1} · ${storagePathLabel(bottle, locations)}`}</p>
                  <p className="field-hint">
                    {[bottleFacts(bottle), bottle.bottleNumber]
                      .filter((value) => value !== null && value !== "")
                      .join(" · ")}
                  </p>
                </div>
                <Button
                  label={`Edit bottle ${index + 1}`}
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    onEditBottle(bottle);
                  }}
                />
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <div className="card-actions">
        {editable && row.bottleCount === 1 ? (
          <Button
            label="Edit"
            size="sm"
            variant="secondary"
            onClick={() => {
              onEditBottle(item);
            }}
          />
        ) : null}
      </div>
    </article>
  );
}

function inventoryCardForBottle(bottleId: string): HTMLElement | null {
  return (
    [...document.querySelectorAll<HTMLElement>("[data-inventory-bottle-ids]")].find(
      (element) => element.dataset["inventoryBottleIds"]?.split("\n").includes(bottleId) === true,
    ) ?? null
  );
}

function drinkStatusBadge(
  status: InventorySummaryItem["drinkStatus"],
): "neutral" | "info" | "warning" | "error" {
  if (status === "past-window") {
    return "error";
  }
  if (status === "drink-now" || status === "drink-soon") {
    return "warning";
  }
  return status === "unknown" ? "neutral" : "info";
}

function wineSubtitle(row: WineRow, locations: readonly LocationItem[]): string {
  const item = row.item;
  const storagePaths = uniqueSorted(
    row.bottles.map((bottle) => storagePathLabel(bottle, locations)),
  );
  const storageSummary = storagePaths.slice(0, 3).join(" / ");
  const storageLabel =
    storagePaths.length > 3
      ? `${storageSummary} / +${storagePaths.length - 3} more`
      : storageSummary;
  return [wineBrandLabel(item), storageLabel].filter((value) => value !== "").join(" - ");
}

function wineBrandLabel(item: InventorySummaryItem): string {
  const brandName = item.brandName?.trim();
  return brandName === undefined || brandName === "" || brandName === item.wineryName
    ? item.wineryName
    : `${item.wineryName} / ${brandName}`;
}

function storagePathLabel(item: InventorySummaryItem, locations: readonly LocationItem[]): string {
  return [item.siteName, storageLocationPath(item, locations), item.positionHint]
    .filter((value) => value !== null && value !== "")
    .join(" / ");
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter((value) => value !== ""))].toSorted((left, right) =>
    left.localeCompare(right),
  );
}
