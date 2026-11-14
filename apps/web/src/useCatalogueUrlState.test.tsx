import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  catalogueStateFromUrl,
  catalogueUrlWithState,
  inventoryQueryPath,
  useCatalogueUrlState,
} from "./useCatalogueUrlState.ts";

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

describe("catalogue URL state", () => {
  it("validates enum parameters and reads filters", () => {
    const state = catalogueStateFromUrl(
      new URL("https://example.test/?area=management&grouping=invalid&q=shiraz"),
    );
    expect(state.area).toBe("management");
    expect(state.grouping).toBe("winery");
    expect(state.filter).toBe("shiraz");
    expect(state.inventoryStatus).toBe("in_stock");
    expect(
      catalogueStateFromUrl(new URL("https://example.test/?drink=unexpected")).drinkStatusFilter,
    ).toBe("");
  });

  it("omits defaults while serialising persistent state", () => {
    const url = catalogueUrlWithState(new URL("https://example.test/cellar?unknown=kept"), {
      area: "inventory",
      drinkStatusFilter: "hold",
      filter: "",
      grouping: "storage",
      inventoryStatus: "in_stock",
      storageLocationIdFilter: "",
      siteIdFilter: "",
      varietalFilter: "Shiraz",
    });
    expect(url.searchParams.get("area")).toBeNull();
    expect(url.searchParams.get("grouping")).toBe("storage");
    expect(url.searchParams.get("varietal")).toBe("Shiraz");
    expect(url.searchParams.get("unknown")).toBe("kept");
    expect(url.searchParams.has("status")).toBe(false);
  });

  it("reads consumed history and ignores drink-window filters there", () => {
    const state = catalogueStateFromUrl(
      new URL("https://example.test/?status=consumed&drink=hold&q=Shiraz&siteId=archive"),
    );
    expect(state.inventoryStatus).toBe("consumed");
    expect(state.drinkStatusFilter).toBe("");
    expect(state.filter).toBe("Shiraz");
    expect(state.siteIdFilter).toBe("archive");
    expect(catalogueStateFromUrl(new URL("https://example.test/?status=any")).inventoryStatus).toBe(
      "in_stock",
    );
    expect(catalogueUrlWithState(new URL("https://example.test/?drink=hold"), state).search).toBe(
      "?status=consumed&q=Shiraz&siteId=archive",
    );
  });

  it("switches inventory status through history while retaining shared filters", () => {
    window.history.replaceState(
      null,
      "",
      "/?grouping=storage&drink=hold&q=Shiraz&siteId=site-a&storageLocationId=rack-a&varietal=Shiraz",
    );
    const { result } = renderHook(() => useCatalogueUrlState());
    act(() => {
      result.current.setInventoryStatus("consumed");
    });
    expect(result.current.inventoryStatus).toBe("consumed");
    expect(result.current.drinkStatusFilter).toBe("");
    expect(result.current.grouping).toBe("storage");
    expect(result.current.storageLocationIdFilter).toBe("rack-a");
    expect(new URL(window.location.href).searchParams.get("status")).toBe("consumed");
    expect(new URL(window.location.href).searchParams.has("drink")).toBe(false);

    act(() => {
      window.history.replaceState(null, "", "/?drink=hold&q=Shiraz");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(result.current.inventoryStatus).toBe("in_stock");
    expect(result.current.drinkStatusFilter).toBe("hold");

    act(() => {
      window.history.replaceState(null, "", "/?status=consumed&drink=drink-now");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(result.current.inventoryStatus).toBe("consumed");
    expect(result.current.drinkStatusFilter).toBe("");
    act(() => {
      result.current.setInventoryStatus("in_stock");
    });
    expect(new URL(window.location.href).searchParams.has("status")).toBe(false);
    expect(result.current.drinkStatusFilter).toBe("");
  });

  it("builds bounded inventory queries with explicit status and opaque filter values", () => {
    const state = catalogueStateFromUrl(new URL("https://example.test/"));
    expect(inventoryQueryPath(state)).toBe("/api/bottles?limit=50&status=in_stock");
    const query = new URL(
      inventoryQueryPath(
        {
          ...state,
          inventoryStatus: "consumed",
          filter: "still being typed",
          drinkStatusFilter: "hold",
          siteIdFilter: "site/with spaces?and=punctuation",
          storageLocationIdFilter: "rack / leaf (旧名)",
          varietalFilter: "Pinot Noir",
        },
        "settled search",
      ),
      "https://example.test",
    );
    expect(Object.fromEntries(query.searchParams)).toEqual({
      limit: "50",
      status: "consumed",
      query: "settled search",
      siteId: "site/with spaces?and=punctuation",
      storageLocationId: "rack / leaf (旧名)",
      grapeVariety: "Pinot Noir",
    });
    expect(inventoryQueryPath({ ...state, drinkStatusFilter: "hold" })).toContain(
      "drinkStatus=hold",
    );
  });

  it("round-trips opaque site and location IDs independently of display names", () => {
    const siteId = "site/with spaces?and=punctuation";
    const storageLocationId = "rack / leaf (旧名)";
    const state = {
      ...catalogueStateFromUrl(new URL("https://example.test/")),
      siteIdFilter: siteId,
      storageLocationIdFilter: storageLocationId,
    };
    const url = catalogueUrlWithState(new URL("https://example.test/?location=Old+cellar"), state);
    expect(url.searchParams.get("siteId")).toBe(siteId);
    expect(url.searchParams.get("storageLocationId")).toBe(storageLocationId);
    expect(url.searchParams.has("location")).toBe(false);
    expect(catalogueStateFromUrl(url)).toEqual(state);
  });

  it("restores state on browser history navigation", () => {
    window.history.replaceState(null, "", "/?area=captures");
    const { result } = renderHook(() => useCatalogueUrlState());
    expect(result.current.area).toBe("captures");

    act(() => {
      result.current.setArea("management");
    });
    expect(window.location.search).toBe("?area=management");

    act(() => {
      window.history.replaceState(null, "", "/?grouping=storage");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(result.current.area).toBe("inventory");
    expect(result.current.grouping).toBe("storage");
  });
});
