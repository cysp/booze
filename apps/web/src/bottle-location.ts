import {
  compareLocationPath,
  locationLabel,
  siteLabel,
  type LocationItem,
  type SiteItem,
} from "./inventory-model.ts";

export type BottleLocationAssignment = {
  readonly location: string;
  readonly site: string;
  readonly siteId: string;
  readonly storageLocationId: string;
};

export function bottleLocationOptions(
  sites: readonly SiteItem[],
  locations: readonly LocationItem[],
): readonly { readonly label: string; readonly value: string }[] {
  return sites.flatMap((site) => [
    {
      label: `${siteLabel(site, sites)} / No specific location`,
      value: `site:${site.id}`,
    },
    ...locations
      .filter((location) => location.siteId === site.id)
      .toSorted(compareLocationPath(locations))
      .map((location) => ({
        label: `${siteLabel(site, sites)} / ${locationLabel(location, locations)}`,
        value: `location:${location.id}`,
      })),
  ]);
}

export function bottleLocationValue(
  selectedSiteId: string,
  selectedStorageLocationId: string,
  sites: readonly SiteItem[],
  locations: readonly LocationItem[],
): string {
  const siteExists = sites.some((site) => site.id === selectedSiteId);
  if (!siteExists) {
    return "";
  }
  return locations.some(
    (location) => location.id === selectedStorageLocationId && location.siteId === selectedSiteId,
  )
    ? `location:${selectedStorageLocationId}`
    : `site:${selectedSiteId}`;
}

export function resolveBottleLocation(
  value: string,
  sites: readonly SiteItem[],
  locations: readonly LocationItem[],
): BottleLocationAssignment {
  if (value.startsWith("site:")) {
    const siteId = value.slice("site:".length);
    const site = sites.find((candidate) => candidate.id === siteId);
    return {
      location: "",
      site: site?.name ?? "",
      siteId: site?.id ?? "",
      storageLocationId: "",
    };
  }
  if (value.startsWith("location:")) {
    const locationId = value.slice("location:".length);
    const location = locations.find((candidate) => candidate.id === locationId);
    const site = sites.find((candidate) => candidate.id === location?.siteId);
    return {
      location: location?.name ?? "",
      site: site?.name ?? "",
      siteId: site?.id ?? "",
      storageLocationId: location?.id ?? "",
    };
  }
  return { location: "", site: "", siteId: "", storageLocationId: "" };
}
