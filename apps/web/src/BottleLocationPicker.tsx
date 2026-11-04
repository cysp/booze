import { Selector } from "@astryxdesign/core/Selector";
import type { ReactElement } from "react";

import {
  bottleLocationOptions,
  bottleLocationValue,
  resolveBottleLocation,
  type BottleLocationAssignment,
} from "./bottle-location.ts";
import { compareLocationPath, type LocationItem, type SiteItem } from "./inventory-model.ts";

type BottleLocationPickerProps = {
  readonly idPrefix: string;
  readonly locations: readonly LocationItem[];
  readonly selectedSiteId: string;
  readonly selectedStorageLocationId: string;
  readonly sites: readonly SiteItem[];
  readonly disabledSite?: boolean | undefined;
  readonly onChange: (selection: BottleLocationAssignment) => void;
};

export function BottleLocationPicker({
  disabledSite = false,
  idPrefix,
  locations,
  selectedSiteId,
  selectedStorageLocationId,
  sites,
  onChange,
}: BottleLocationPickerProps): ReactElement {
  const selectedSite = sites.find((site) => site.siteId === selectedSiteId);
  const selectableSites = disabledSite && selectedSite !== undefined ? [selectedSite] : sites;
  const siteLocations = locations
    .filter((location) => location.siteId === selectedSiteId)
    .toSorted(compareLocationPath(locations));
  const selectedStorageLocation = siteLocations.find(
    (location) => location.locationId === selectedStorageLocationId,
  );
  const selectedValue = bottleLocationValue(
    selectedSiteId,
    selectedStorageLocationId,
    sites,
    locations,
  );
  const options = bottleLocationOptions(selectableSites, locations);

  return (
    <Selector
      htmlName={`${idPrefix}.storageLocation`}
      isRequired
      description={
        selectedStorageLocation === undefined
          ? "Choose the site, or the most specific known place."
          : selectedStorageLocation.locationType
      }
      {...(selectableSites.length === 0
        ? { disabledMessage: "Create a site before assigning a bottle location." }
        : {})}
      isDisabled={selectableSites.length === 0}
      label="Bottle location"
      options={[...options]}
      placeholder={sites.length === 0 ? "Create a site first" : "Choose site or location"}
      value={selectedValue}
      onChange={(value: string) => {
        onChange(resolveBottleLocation(value, sites, locations));
      }}
    />
  );
}
