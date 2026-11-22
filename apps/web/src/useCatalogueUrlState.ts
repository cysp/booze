import { useCallback, useEffect, useRef, useState } from "react";

import type { Area, InventoryGrouping, InventoryItem } from "./inventory-model.ts";

type DrinkStatusFilter = "" | InventoryItem["drinkStatus"];

export type CatalogueUrlState = {
  readonly area: Area;
  readonly drinkStatusFilter: DrinkStatusFilter;
  readonly filter: string;
  readonly grouping: InventoryGrouping;
  readonly storageLocationIdFilter: string;
  readonly siteIdFilter: string;
  readonly varietalFilter: string;
};

type CatalogueUrlController = CatalogueUrlState & {
  readonly setArea: (value: Area) => void;
  readonly setDrinkStatusFilter: (value: string) => void;
  readonly setFilter: (value: string) => void;
  readonly setGrouping: (value: InventoryGrouping) => void;
  readonly setSiteIdFilter: (value: string) => void;
  readonly setStorageLocationIdFilter: (value: string) => void;
  readonly setVarietalFilter: (value: string) => void;
};

const defaultState: CatalogueUrlState = {
  area: "inventory",
  drinkStatusFilter: "",
  filter: "",
  grouping: "winery",
  storageLocationIdFilter: "",
  siteIdFilter: "",
  varietalFilter: "",
};

const catalogueFragmentPrefix = "#catalogue?";
const largeFilterParameters = ["q", "varietal", "siteId", "storageLocationId"] as const;

function expandCatalogueUrl(url: URL): URL {
  const next = new URL(url);
  if (!next.hash.startsWith(catalogueFragmentPrefix)) return next;
  const fragment = new URLSearchParams(next.hash.slice(catalogueFragmentPrefix.length));
  for (const key of largeFilterParameters) {
    const value = fragment.get(key);
    if (value !== null) next.searchParams.set(key, value);
  }
  next.hash = fragment.get("anchor") ?? "";
  return next;
}

export function catalogueStateFromUrl(input: URL): CatalogueUrlState {
  const url = expandCatalogueUrl(input);
  const area = url.searchParams.get("area");
  const grouping = url.searchParams.get("grouping");
  return {
    area: area === "captures" || area === "management" ? area : "inventory",
    drinkStatusFilter: parseDrinkStatus(url.searchParams.get("drink")),
    filter: url.searchParams.get("q") ?? "",
    grouping: grouping === "storage" ? "storage" : "winery",
    storageLocationIdFilter: url.searchParams.get("storageLocationId") ?? "",
    siteIdFilter: url.searchParams.get("siteId") ?? "",
    varietalFilter: url.searchParams.get("varietal") ?? "",
  };
}

export function catalogueUrlWithState(url: URL, state: CatalogueUrlState): URL {
  const next = expandCatalogueUrl(url);
  setOptionalParameter(next, "area", state.area, defaultState.area);
  setOptionalParameter(next, "grouping", state.grouping, defaultState.grouping);
  setOptionalParameter(next, "q", state.filter);
  setOptionalParameter(next, "varietal", state.varietalFilter);
  setOptionalParameter(next, "storageLocationId", state.storageLocationIdFilter);
  setOptionalParameter(next, "siteId", state.siteIdFilter);
  next.searchParams.delete("location");
  setOptionalParameter(next, "drink", state.drinkStatusFilter);
  if (next.href.length - next.hash.length >= 16 * 1024) {
    const fragment = new URLSearchParams();
    if (next.hash) fragment.set("anchor", next.hash);
    for (const key of largeFilterParameters) {
      const value = next.searchParams.get(key);
      if (value !== null) {
        fragment.set(key, value);
        next.searchParams.delete(key);
      }
    }
    next.hash = catalogueFragmentPrefix + fragment.toString();
  }
  return next;
}

export function useCatalogueUrlState(): CatalogueUrlController {
  const [state, setState] = useState(() => catalogueStateFromUrl(new URL(window.location.href)));
  const stateRef = useRef(state);

  useEffect(() => {
    const readHistory = (): void => {
      const next = catalogueStateFromUrl(new URL(window.location.href));
      stateRef.current = next;
      setState(next);
    };
    window.addEventListener("popstate", readHistory);
    return () => {
      window.removeEventListener("popstate", readHistory);
    };
  }, []);

  const update = useCallback(
    <Key extends keyof CatalogueUrlState>(
      key: Key,
      value: CatalogueUrlState[Key],
      historyMode: "push" | "replace",
    ): void => {
      const next = { ...stateRef.current, [key]: value };
      if (key === "siteIdFilter" && value !== "" && value !== stateRef.current.siteIdFilter)
        next.storageLocationIdFilter = "";
      stateRef.current = next;
      setState(next);
      const nextUrl = catalogueUrlWithState(new URL(window.location.href), next);
      window.history[historyMode === "push" ? "pushState" : "replaceState"](null, "", nextUrl);
    },
    [],
  );

  return {
    ...state,
    setArea: (value: Area): void => {
      update("area", value, "push");
    },
    setDrinkStatusFilter: (value: string): void => {
      update("drinkStatusFilter", parseDrinkStatus(value), "replace");
    },
    setFilter: (value: string): void => {
      update("filter", value, "replace");
    },
    setGrouping: (value: InventoryGrouping): void => {
      update("grouping", value, "push");
    },
    setSiteIdFilter: (value: string): void => {
      update("siteIdFilter", value, "replace");
    },
    setStorageLocationIdFilter: (value: string): void => {
      update("storageLocationIdFilter", value, "replace");
    },
    setVarietalFilter: (value: string): void => {
      update("varietalFilter", value, "replace");
    },
  };
}

function parseDrinkStatus(value: string | null): DrinkStatusFilter {
  switch (value) {
    case "drink-now":
    case "drink-soon":
    case "hold":
    case "past-window":
    case "unknown":
      return value;
    case null:
      return "";
    default:
      return "";
  }
}

function setOptionalParameter(url: URL, key: string, value: string, defaultValue = ""): void {
  if (value === defaultValue) {
    url.searchParams.delete(key);
  } else {
    url.searchParams.set(key, value);
  }
}
