import type { BottleInput, WinePatchInput } from "../shared/catalogue-inputs.ts";
import type {
  BottleResource,
  SiteResource,
  StorageLocationResource,
} from "../shared/catalogue-resources.ts";
import { calculateDrinkStatus, type DrinkStatus } from "../shared/drink-status.ts";
export type { DrinkStatus } from "../shared/drink-status.ts";
import type { BottleSummary } from "../shared/inventory-queries.ts";
import type { VintageStatus } from "../shared/wine-identity.ts";
import { validateBottleQuantity } from "../shared/quantity.ts";

export type AuthMode = "clerk" | "development";
export type Area = "inventory" | "captures" | "management";
export type InventoryGrouping = "winery" | "storage";

export type {
  BottleResource,
  CaptureImageResource,
  CaptureResource,
  CaptureRunResource,
  CriticReviewResource,
  SiteResource,
  StorageLocationResource,
  WineAwardResource,
} from "../shared/catalogue-resources.ts";

export type CaptureFormState = {
  siteId: string;
  site: string;
  storageLocationId: string;
  location: string;
  position: string;
  quantity: string;
};

export type InventoryItem = BottleResource & { readonly drinkStatus: DrinkStatus };
export type InventorySummaryItem = BottleSummary & { readonly drinkStatus: DrinkStatus };
export type LocationItem = StorageLocationResource;
export type SiteItem = SiteResource;

export type FormState = {
  siteId: string;
  site: string;
  storageLocationId: string;
  location: string;
  position: string;
  quantity: string;
  wineryName: string;
  brandName: string;
  designation: string;
  vintageStatus: VintageStatus;
  vintageYear: string;
  grapeVarieties: readonly string[];
  country: string;
  region: string;
  appellation: string;
  classification: string;
  wineType: string;
  wineColor: string;
  alcoholPercent: string;
  bottleVolumeMl: string;
  bottleNumber: string;
  addressQualification: string;
  barcode: string;
  lotCode: string;
  drinkFromYear: string;
  drinkToYear: string;
  description: string;
  drinkingAdvice: string;
  sourceUrl: string;
  wineNotes: string;
  labelText: string;
  labelExtractionJson: string;
  bottleNotes: string;
};

export type LocationFormState = {
  siteId: string;
  site: string;
  parentLocationId: string;
  location: string;
};

export type SiteFormState = {
  site: string;
};

export type BottlePatch = {
  readonly wineEditScope?: "shared" | "bottle" | undefined;
  readonly wineVintageId?: string | undefined;
  readonly expectedWineVintageId?: string | undefined;
  readonly expectedAffectedBottleCount?: number | undefined;
  readonly allowUnidentified?: boolean | undefined;
  readonly status?: "in_stock" | "consumed";
  readonly storageLocationId?: string | null | undefined;
  readonly positionHint?: string | undefined;
  readonly bottle?: BottleInput | undefined;
  readonly wine?: WinePatchInput | undefined;
  readonly labelExtraction?:
    | {
        readonly extractedFieldsJson: string;
      }
    | undefined;
  readonly criticReviews?: readonly CriticReviewInput[] | undefined;
  readonly awards?: readonly WineAwardInput[] | undefined;
};

export type CriticReviewInput = {
  readonly id?: string | undefined;
  readonly reviewSourceId?: string | undefined;
  readonly reviewSourceName?: string | undefined;
  readonly ratingText: string;
  readonly ratingValue?: number | undefined;
  readonly ratingScale?: string | undefined;
  readonly sourceUrl?: string | undefined;
  readonly reviewedAt?: string | undefined;
  readonly provenance?: string | undefined;
  readonly notes?: string | undefined;
};

export type WineAwardInput = {
  readonly id?: string | undefined;
  readonly awardName: string;
  readonly awardLevel: string;
  readonly awardYear?: number | undefined;
  readonly awardBody?: string | undefined;
  readonly category?: string | undefined;
  readonly points?: number | undefined;
  readonly sourceUrl?: string | undefined;
  readonly provenance?: string | undefined;
  readonly notes?: string | undefined;
};

export const initialFormState: FormState = {
  siteId: "",
  site: "home",
  storageLocationId: "",
  location: "",
  position: "",
  quantity: "1",
  wineryName: "",
  brandName: "",
  designation: "",
  vintageStatus: "unknown",
  vintageYear: "",
  grapeVarieties: [],
  country: "",
  region: "",
  appellation: "",
  classification: "",
  wineType: "",
  wineColor: "",
  alcoholPercent: "",
  bottleVolumeMl: "",
  bottleNumber: "",
  addressQualification: "",
  barcode: "",
  lotCode: "",
  drinkFromYear: "",
  drinkToYear: "",
  description: "",
  drinkingAdvice: "",
  sourceUrl: "",
  wineNotes: "",
  labelText: "",
  labelExtractionJson: "",
  bottleNotes: "",
};

export const initialLocationFormState: LocationFormState = {
  siteId: "",
  site: "home",
  parentLocationId: "",
  location: "",
};

export const initialSiteFormState: SiteFormState = {
  site: "home",
};

export const initialCaptureFormState: CaptureFormState = {
  siteId: "",
  site: "home",
  storageLocationId: "",
  location: "",
  position: "",
  quantity: "1",
};

export function parseOptionalYear(value: string): number | undefined {
  const trimmed = value.trim();
  return /^\d{4}$/u.test(trimmed) ? Number(trimmed) : undefined;
}

export function parseOptionalDecimal(value: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?|\.\d+)\s*(?:%\s*(?:alc\/vol)?)?$/iu.exec(value.trim());
  return match === null ? undefined : Number(match[1]);
}

export function parseOptionalVolumeMl(value: string): number | undefined {
  const match = /^(\d+)\s*(?:ml)?$/iu.exec(value.trim());
  return match === null ? undefined : Number(match[1]);
}

export function parseQuantity(value: string): number {
  const result = validateBottleQuantity(value);
  if (!result.ok) {
    throw new RangeError(result.message);
  }
  return result.value;
}

export function wineDisplayBrand(item: InventorySummaryItem): string {
  return item.wineryName;
}

export function bottleTitle(item: InventorySummaryItem): string {
  return [item.vintageLabel, item.displayName].filter((value) => value !== "").join(" ");
}

export function locationPath(location: LocationItem, locations: readonly LocationItem[]): string {
  const locationsById = new Map(locations.map((candidate) => [candidate.id, candidate]));
  const parts = [location.name];
  let parentId = location.parentId;
  const seen = new Set([location.id]);

  while (parentId !== null && !seen.has(parentId)) {
    const parent = locationsById.get(parentId);
    if (parent === undefined) {
      break;
    }
    parts.unshift(parent.name);
    seen.add(parent.id);
    parentId = parent.parentId;
  }

  return parts.join(" / ");
}

export function compareLocationPath(
  locations: readonly LocationItem[],
): (left: LocationItem, right: LocationItem) => number {
  return (left, right) =>
    locationPath(left, locations).localeCompare(locationPath(right, locations));
}

export function storageLocationLabel({
  locationId,
  locationName,
  locations,
}: {
  readonly locationId: string | null;
  readonly locationName: string | null;
  readonly locations: readonly LocationItem[];
}): string {
  const location =
    locationId === null ? undefined : locations.find((candidate) => candidate.id === locationId);
  return location === undefined
    ? (locationName ?? "No storage location")
    : locationPath(location, locations);
}

export function storageLocationPath(
  item: InventorySummaryItem,
  locations: readonly LocationItem[] = [],
): string {
  return storageLocationLabel({
    locationId: item.storageLocationId,
    locationName: item.storageLocationName,
    locations,
  });
}

export function storagePath(
  item: InventorySummaryItem,
  locations: readonly LocationItem[] = [],
): string {
  return [item.siteName, storageLocationPath(item, locations), item.positionHint]
    .filter((value) => value !== null && value !== "")
    .join(" / ");
}

function normaliseDisplayText(value: string): string {
  return value.trim().toLowerCase().replaceAll(/\s+/gu, " ");
}

export function bottleSubtitle(
  item: InventorySummaryItem,
  locations: readonly LocationItem[] = [],
): string {
  const brandName = item.brandName?.trim();
  const wineryLabel =
    brandName === undefined ||
    brandName === "" ||
    normaliseDisplayText(brandName) === normaliseDisplayText(item.wineryName)
      ? item.wineryName
      : `${item.wineryName} / ${brandName}`;
  return [wineryLabel, storagePath(item, locations)].filter((value) => value !== "").join(" - ");
}

export function wineOrigin(item: InventorySummaryItem): string {
  return [item.appellation, item.region, item.country]
    .filter((value) => value !== null && value !== "")
    .join(" / ");
}

export function grapeSummary(item: InventorySummaryItem): string {
  return item.grapeVarieties.length === 0 ? "Grapes not set" : item.grapeVarieties.join(", ");
}

export function bottleFacts(item: InventorySummaryItem): string {
  return [item.alcoholPercent === null ? null : `${item.alcoholPercent}%`, `${item.volumeMl}ml`]
    .filter((value) => value !== null && value !== "")
    .join(" / ");
}

export function drinkWindow(item: InventorySummaryItem): string {
  if (item.drinkFromYear === null && item.drinkToYear === null) {
    return "No window";
  }
  return `${item.drinkFromYear ?? "?"}-${item.drinkToYear ?? "?"}`;
}

export function drinkLabel(status: InventoryItem["drinkStatus"]): string {
  switch (status) {
    case "drink-now":
      return "Drink now";
    case "drink-soon":
      return "Drink soon";
    case "hold":
      return "Hold";
    case "past-window":
      return "Past window";
    case "unknown":
      return "Unknown";
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

function formText(value: string | null): string {
  return value ?? "";
}

function formYear(value: number | null): string {
  return value === null ? "" : String(value);
}

export function formStateForItem(item: InventoryItem): FormState {
  return {
    siteId: item.siteId,
    site: item.siteName,
    storageLocationId: item.storageLocationId ?? "",
    location: formText(item.storageLocationName),
    position: formText(item.positionHint),
    quantity: "1",
    wineryName: item.wineryName,
    brandName: formText(item.brandName),
    designation: formText(item.designation),
    vintageStatus: item.vintageStatus,
    vintageYear: formYear(item.vintageYear),
    grapeVarieties: item.grapeVarieties,
    country: formText(item.country),
    region: formText(item.region),
    appellation: formText(item.appellation),
    classification: formText(item.classification),
    wineType: formText(item.wineType),
    wineColor: formText(item.wineColor),
    alcoholPercent: formYear(item.alcoholPercent),
    bottleVolumeMl: String(item.volumeMl),
    bottleNumber: formText(item.bottleNumber),
    addressQualification: formText(item.addressQualification),
    barcode: formText(item.barcode),
    lotCode: formText(item.lotCode),
    drinkFromYear: formYear(item.drinkFromYear),
    drinkToYear: formYear(item.drinkToYear),
    description: formText(item.description),
    drinkingAdvice: formText(item.drinkingAdvice),
    sourceUrl: formText(item.sourceUrl),
    wineNotes: formText(item.wineNotes),
    labelText: formText(item.labelText),
    labelExtractionJson: "",
    bottleNotes: formText(item.bottleNotes),
  };
}

export function inventorySummaryItem(resource: BottleSummary): InventorySummaryItem {
  return { ...resource, drinkStatus: calculateDrinkStatus(resource) };
}

export function inventoryItem(resource: BottleResource): InventoryItem {
  return { ...resource, drinkStatus: calculateDrinkStatus(resource) };
}

export function siteLabel(
  site: Pick<SiteResource, "id" | "name">,
  sites: readonly Pick<SiteResource, "id" | "name">[],
): string {
  return sites.some((candidate) => candidate.id !== site.id && candidate.name === site.name)
    ? `${site.name} (${site.id})`
    : site.name;
}

export function locationLabel(location: LocationItem, locations: readonly LocationItem[]): string {
  const path = locationPath(location, locations);
  return locations.some(
    (candidate) =>
      candidate.id !== location.id &&
      candidate.siteId === location.siteId &&
      locationPath(candidate, locations) === path,
  )
    ? `${path} (${location.id})`
    : path;
}
