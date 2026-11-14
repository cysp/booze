import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  catalogueStateFromUrl,
  catalogueUrlWithState,
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
      storageLocationIdFilter: "",
      siteIdFilter: "",
      varietalFilter: "Shiraz",
    });
    expect(url.searchParams.get("area")).toBeNull();
    expect(url.searchParams.get("grouping")).toBe("storage");
    expect(url.searchParams.get("varietal")).toBe("Shiraz");
    expect(url.searchParams.get("unknown")).toBe("kept");
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
