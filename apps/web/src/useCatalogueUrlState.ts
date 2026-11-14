import { useCallback, useEffect, useRef, useState } from "react";

import type { Area, InventoryGrouping, InventoryItem } from "./inventory-model.ts";

type DrinkStatusFilter = "" | InventoryItem["drinkStatus"];

export type CatalogueUrlState = {
  readonly area: Area;
  readonly drinkStatusFilter: DrinkStatusFilter;
  readonly filter: string;
  readonly grouping: InventoryGrouping;
  readonly inventoryStatus: "in_stock" | "consumed";
  readonly storageLocationIdFilter: string;
  readonly siteIdFilter: string;
  readonly varietalFilter: string;
};

type CatalogueUrlController = CatalogueUrlState & {
  readonly setArea: (value: Area) => void;
  readonly setDrinkStatusFilter: (value: string) => void;
  readonly setFilter: (value: string) => void;
  readonly setGrouping: (value: InventoryGrouping) => void;
  readonly setInventoryStatus: (value: CatalogueUrlState["inventoryStatus"]) => void;
  readonly setSiteIdFilter: (value: string) => void;
  readonly setStorageLocationIdFilter: (value: string) => void;
  readonly setVarietalFilter: (value: string) => void;
};

const defaultState: CatalogueUrlState = {
  area: "inventory",
  drinkStatusFilter: "",
  filter: "",
  grouping: "winery",
  inventoryStatus: "in_stock",
  storageLocationIdFilter: "",
  siteIdFilter: "",
  varietalFilter: "",
};

export function catalogueStateFromUrl(url: URL): CatalogueUrlState {
  const area = url.searchParams.get("area");
  const grouping = url.searchParams.get("grouping");
  const inventoryStatus = url.searchParams.get("status") === "consumed" ? "consumed" : "in_stock";
  return {
    area: area === "captures" || area === "management" ? area : "inventory",
    drinkStatusFilter:
      inventoryStatus === "consumed" ? "" : parseDrinkStatus(url.searchParams.get("drink")),
    filter: url.searchParams.get("q") ?? "",
    grouping: grouping === "storage" ? "storage" : "winery",
    inventoryStatus,
    storageLocationIdFilter: url.searchParams.get("storageLocationId") ?? "",
    siteIdFilter: url.searchParams.get("siteId") ?? "",
    varietalFilter: url.searchParams.get("varietal") ?? "",
  };
}

export function catalogueUrlWithState(url: URL, state: CatalogueUrlState): URL {
  const next = new URL(url);
  setOptionalParameter(next, "area", state.area, defaultState.area);
  setOptionalParameter(next, "grouping", state.grouping, defaultState.grouping);
  setOptionalParameter(next, "status", state.inventoryStatus, defaultState.inventoryStatus);
  setOptionalParameter(next, "q", state.filter);
  setOptionalParameter(next, "varietal", state.varietalFilter);
  setOptionalParameter(next, "storageLocationId", state.storageLocationIdFilter);
  setOptionalParameter(next, "siteId", state.siteIdFilter);
  next.searchParams.delete("location");
  setOptionalParameter(
    next,
    "drink",
    state.inventoryStatus === "consumed" ? "" : state.drinkStatusFilter,
  );
  return next;
}

export function inventoryQueryPath(state: CatalogueUrlState, query = state.filter): string {
  const parameters = new URLSearchParams({ limit: "50", status: state.inventoryStatus });
  if (query !== "") parameters.set("query", query);
  if (state.siteIdFilter !== "") parameters.set("siteId", state.siteIdFilter);
  if (state.storageLocationIdFilter !== "")
    parameters.set("storageLocationId", state.storageLocationIdFilter);
  if (state.varietalFilter !== "") parameters.set("grapeVariety", state.varietalFilter);
  if (state.inventoryStatus === "in_stock" && state.drinkStatusFilter !== "")
    parameters.set("drinkStatus", state.drinkStatusFilter);
  return `/api/bottles?${parameters.toString()}`;
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
      const candidate = { ...stateRef.current, [key]: value };
      const next =
        candidate.inventoryStatus === "consumed"
          ? { ...candidate, drinkStatusFilter: "" as const }
          : candidate;
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
    setInventoryStatus: (value: CatalogueUrlState["inventoryStatus"]): void => {
      update("inventoryStatus", value, "push");
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
