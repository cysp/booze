import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bottles, captures, locations, sites } from "../e2e/catalogue-fixtures.ts";
import { useCatalogue } from "./useCatalogue.ts";
import { useBottleController, useCaptureController } from "./useCatalogueControllers.ts";
import { initialCaptureFormState, initialFormState } from "./inventory-model.ts";
import { catalogueStateFromUrl, inventoryQueryPath } from "./useCatalogueUrlState.ts";

const auth = async (): Promise<Record<string, string>> => ({});
const inventoryOptions = {
  area: "inventory",
  inventoryPath: "/api/bottles?limit=50",
  captureView: "action",
} as const;
const captureOptions = { ...inventoryOptions, area: "captures" } as const;
const summary = {
  inStockBottleCount: 101,
  drinkQueueBottleCount: 25,
  captures: { actionable: 1, processing: 0, imported: 5 },
};
const captureSummaries = captures.map((capture) => ({
  ...capture,
  imageCount: 0,
  previewImage: null,
}));
function response(data: unknown): Response {
  return new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
}
function inventoryResponse(data: readonly unknown[] = bottles): Response {
  return response({
    data,
    totalCount: 101,
    nextPageToken: "next",
    facets: { grapeVarieties: ["Shiraz", "Riesling"], drinkStatuses: ["drink-now"] },
  });
}
function captureResponse(data: readonly unknown[] = captureSummaries): Response {
  return response({ data, totalCount: data.length, nextPageToken: null, counts: summary.captures });
}
function fixture(input: string | URL | Request): Response {
  const url = new URL(input instanceof Request ? input.url : String(input), window.location.origin);
  if (url.pathname === "/api/bottles") return inventoryResponse();
  if (url.pathname === "/api/bottle-captures") return captureResponse();
  if (url.pathname === "/api/catalogue-summary") return response({ data: summary });
  if (url.pathname === "/api/sites") return response({ data: sites });
  if (url.pathname === "/api/storage-locations") return response({ data: locations });
  if (url.pathname === "/api/bottle-capture-statuses") return response({ data: [] });
  throw new Error(`Unexpected request ${url.pathname}`);
}
const pathOf = (input: string | URL | Request) =>
  new URL(input instanceof Request ? input.url : String(input), window.location.origin).pathname;
afterEach(() => {
  sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("page-scoped catalogue ownership", () => {
  it("keeps consumed history paging scoped to status and opaque shared filters", async () => {
    const requests: URL[] = [];
    const historyState = catalogueStateFromUrl(
      new URL(
        "https://example.test/?status=consumed&q=Shiraz&siteId=site%2Fone&storageLocationId=rack%3Ftwo&varietal=Shiraz",
      ),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
          window.location.origin,
        );
        requests.push(url);
        if (url.pathname === "/api/bottles" && url.searchParams.get("status") === "consumed")
          return response({
            data: [
              {
                ...bottles[0],
                id: url.searchParams.has("pageToken") ? "history-second" : "history-first",
                status: "consumed",
              },
            ],
            totalCount: 81,
            nextPageToken: url.searchParams.has("pageToken") ? null : "history-next",
            facets: { grapeVarieties: ["Shiraz"], drinkStatuses: ["drink-now"] },
          });
        return fixture(input);
      }),
    );
    const { result, rerender } = renderHook(
      ({ path }) => useCatalogue(auth, { ...inventoryOptions, inventoryPath: path }),
      { initialProps: { path: "/api/bottles?limit=50&status=in_stock" } },
    );
    await waitFor(() => {
      expect(result.current.items).toHaveLength(1);
    });
    requests.length = 0;
    rerender({ path: inventoryQueryPath(historyState) });
    await waitFor(() => {
      expect(result.current.items.map((item) => item.id)).toEqual(["history-first"]);
    });
    expect(result.current.inventory.page?.totalCount).toBe(81);
    expect(result.current.summary.inStockBottleCount).toBe(101);
    await act(async () => result.current.inventory.loadMore());
    expect(result.current.items.map((item) => item.id)).toEqual([
      "history-first",
      "history-second",
    ]);
    expect(requests).toHaveLength(2);
    expect(Object.fromEntries(requests[1]?.searchParams ?? [])).toEqual({
      limit: "50",
      status: "consumed",
      query: "Shiraz",
      siteId: "site/one",
      storageLocationId: "rack?two",
      grapeVariety: "Shiraz",
      pageToken: "history-next",
    });
  });

  it("refreshes consumed history after a restore without removing the surviving physical bottle", async () => {
    let restored = false;
    const requests: URL[] = [];
    const surviving = { ...bottles[0], id: "still-consumed", status: "consumed" };
    const restoreTarget = { ...bottles[0], id: "restored-bottle", status: "consumed" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
          window.location.origin,
        );
        requests.push(url);
        if (url.pathname === "/api/bottles")
          return response({
            data: restored ? [surviving] : [restoreTarget, surviving],
            totalCount: restored ? 1 : 2,
            nextPageToken: null,
            facets: { grapeVarieties: ["Shiraz"], drinkStatuses: ["drink-now"] },
          });
        if (url.pathname === "/api/catalogue-summary")
          return response({
            data: { ...summary, inStockBottleCount: restored ? 102 : 101 },
          });
        return fixture(input);
      }),
    );
    const { result } = renderHook(() =>
      useCatalogue(auth, {
        ...inventoryOptions,
        inventoryPath: "/api/bottles?limit=50&status=consumed&siteId=site-owner",
      }),
    );
    await waitFor(() => {
      expect(result.current.items).toHaveLength(2);
    });
    requests.length = 0;
    restored = true;
    await act(async () =>
      result.current.completeMutation({ refresh: "catalogue", successMessage: "Bottle restored." }),
    );
    expect(result.current.items.map((item) => item.id)).toEqual(["still-consumed"]);
    expect(result.current.inventory.page?.totalCount).toBe(1);
    expect(result.current.summary.inStockBottleCount).toBe(102);
    expect(result.current.status).toBe("Bottle restored.");
    const historyRequests = requests.filter((request) => request.pathname === "/api/bottles");
    expect(historyRequests).toHaveLength(1);
    expect(historyRequests[0]?.searchParams.get("status")).toBe("consumed");
    expect(historyRequests[0]?.searchParams.get("siteId")).toBe("site-owner");
    expect(requests.some((request) => request.pathname === "/api/bottle-captures")).toBe(false);
  });

  it("loads only the active inventory page and light resources; counts and facets cover unloaded rows", async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => fixture(input));
    vi.stubGlobal("fetch", fetch);
    const { result } = renderHook(() => useCatalogue(auth));
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    expect(fetch.mock.calls.map(([input]) => pathOf(input)).toSorted()).toEqual(
      ["/api/bottles", "/api/catalogue-summary", "/api/sites", "/api/storage-locations"].toSorted(),
    );
    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0]).not.toHaveProperty("bottleNotes");
    expect(result.current.summary.inStockBottleCount).toBe(101);
    expect(result.current.inventory.page?.facets.grapeVarieties).toEqual(["Shiraz", "Riesling"]);
    expect(result.current.captures).toEqual([]);
  });
  it("loads capture summaries on visiting capture and no native lists in storage", async () => {
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        requests.push(pathOf(input));
        return fixture(input);
      }),
    );
    const { result, rerender } = renderHook(
      ({ area }: { readonly area: "inventory" | "captures" | "management" }) =>
        useCatalogue(auth, { ...inventoryOptions, area }),
      { initialProps: { area: "management" } },
    );
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    expect(requests).not.toContain("/api/bottles");
    expect(requests).not.toContain("/api/bottle-captures");
    requests.length = 0;
    rerender({ area: "captures" });
    await waitFor(() => {
      expect(result.current.captures).toHaveLength(1);
    });
    expect(requests).toEqual(["/api/bottle-captures"]);
    expect(result.current.captures[0]).not.toHaveProperty("latestRun");
    expect(result.current.captures[0]).not.toHaveProperty("reviewCandidate");
  });
  it("keeps committed feedback and stale data on refresh failure, and retries only the failed read", async () => {
    let failed = false;
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const path = pathOf(input);
        requests.push(path);
        return failed && path === "/api/sites"
          ? new Response(null, { status: 503 })
          : fixture(input);
      }),
    );
    const { result } = renderHook(() => useCatalogue(auth));
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    failed = true;
    await act(async () =>
      result.current.completeMutation({ refresh: "catalogue", successMessage: "Bottle saved." }),
    );
    expect(result.current.status).toBe("Bottle saved. Latest data could not be refreshed.");
    expect(result.current.sites).toEqual(sites);
    expect(result.current.refreshIssues).toEqual([
      { collection: "sites", message: "Sites could not be refreshed. Try again." },
    ]);
    failed = false;
    requests.length = 0;
    await act(async () => result.current.retryRefresh("sites"));
    expect(requests).toEqual(["/api/sites"]);
    expect(result.current.refreshIssues).toEqual([]);
  });
  it("does not erase an independent failure when a capture mutation refreshes its own area", async () => {
    let failed = false;
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const path = pathOf(input);
        requests.push(path);
        return failed && path === "/api/sites"
          ? new Response(null, { status: 503 })
          : fixture(input);
      }),
    );
    const { result } = renderHook(() => useCatalogue(auth, captureOptions));
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    failed = true;
    await act(async () =>
      result.current.completeMutation({ refresh: "catalogue", successMessage: "Saved." }),
    );
    requests.length = 0;
    await act(async () =>
      result.current.completeMutation({ refresh: "captures", successMessage: "Capture deleted." }),
    );
    expect(requests.toSorted()).toEqual(
      ["/api/catalogue-summary", "/api/bottle-captures"].toSorted(),
    );
    expect(result.current.refreshIssues.map((issue) => issue.collection)).toEqual(["sites"]);
    expect(result.current.status).toBe("Capture deleted.");
  });
  it("keeps newer foreground progress when an older retry finishes", async () => {
    let retry = false;
    let resolve: ((response: Response) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) =>
        pathOf(input) === "/api/sites"
          ? retry
            ? new Promise<Response>((done) => {
                resolve = done;
              })
            : new Response(null, { status: 503 })
          : fixture(input),
      ),
    );
    const { result } = renderHook(() => useCatalogue(auth));
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    retry = true;
    let pending = Promise.resolve();
    await act(async () => {
      pending = result.current.retryRefresh("sites");
    });
    act(() => {
      result.current.setStatus("Saving another bottle...");
    });
    await act(async () => {
      resolve?.(response({ data: sites }));
      await pending;
    });
    expect(result.current.status).toBe("Saving another bottle...");
    expect(result.current.refreshIssues).toEqual([]);
  });
  it.each([
    { path: "/api/bottles", value: { ...bottles[0], volumeMl: "750" }, collection: "inventory" },
    {
      path: "/api/bottles",
      value: { ...bottles[0], grapeVarieties: [7] },
      collection: "inventory",
    },
    { path: "/api/sites", value: { ...sites[0], bottleCount: "three" }, collection: "sites" },
    {
      path: "/api/storage-locations",
      value: { ...locations[0], parentId: 9 },
      collection: "locations",
    },
  ])("rejects malformed $collection responses", async ({ path, value, collection }) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) =>
        pathOf(input) === path
          ? path === "/api/bottles"
            ? inventoryResponse([value])
            : response({ data: [value] })
          : fixture(input),
      ),
    );
    const { result } = renderHook(() => useCatalogue(auth));
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    expect(result.current.refreshIssues.map((issue) => issue.collection)).toContain(collection);
  });
  it("retains a newer capture failure and status after an older catalogue batch settles", async () => {
    let slow = false;
    let failCapture = false;
    let resolve: ((response: Response) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const path = pathOf(input);
        if (slow && path === "/api/sites")
          return new Promise<Response>((done) => {
            resolve = done;
          });
        if (failCapture && path === "/api/bottle-captures")
          return new Response(null, { status: 503 });
        return fixture(input);
      }),
    );
    const { result } = renderHook(() => useCatalogue(auth, captureOptions));
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    slow = true;
    let older = Promise.resolve();
    await act(async () => {
      older = result.current.completeMutation({
        refresh: "catalogue",
        successMessage: "Older save.",
      });
    });
    failCapture = true;
    await act(async () =>
      result.current.completeMutation({ refresh: "captures", successMessage: "Capture deleted." }),
    );
    await act(async () => {
      resolve?.(response({ data: sites }));
      await older;
    });
    expect(result.current.status).toBe("Capture deleted. Latest data could not be refreshed.");
    expect(result.current.refreshIssues.map((issue) => issue.collection)).toContain("captures");
    expect(result.current.captures).toHaveLength(1);
  });
  it("polls compact known IDs while inventory is active and treats missing as uncertain invalidation", async () => {
    vi.useFakeTimers();
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        requests.push(pathOf(input));
        return fixture(input);
      }),
    );
    const { result } = renderHook(() => useCatalogue(auth));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    act(() => {
      result.current.trackPendingCapture("opaque/id");
    });
    requests.length = 0;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(requests).toContain("/api/bottle-capture-statuses");
    expect(requests).toContain("/api/bottles");
    expect(requests).not.toContain("/api/bottle-captures");
    expect(result.current.status).not.toContain("imported");
  });
  it("pauses progress polling in hidden tabs and checks immediately on return", async () => {
    vi.useFakeTimers();
    const visible = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        requests.push(pathOf(input));
        return fixture(input);
      }),
    );
    const { result } = renderHook(() => useCatalogue(auth));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    act(() => {
      result.current.trackPendingCapture("pending");
    });
    requests.length = 0;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(requests).toEqual([]);
    visible.mockReturnValue("visible");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(requests).toContain("/api/bottle-capture-statuses");
  });
  it("limits a polling tick to 100 IDs and rotates through known work", async () => {
    vi.useFakeTimers();
    const batches: string[][] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
          window.location.origin,
        );
        if (url.pathname === "/api/bottle-capture-statuses") {
          const ids = url.searchParams.getAll("captureId");
          batches.push(ids);
          return response({
            data: ids.map((id) => ({
              id,
              status: "extracting",
              updatedAt: "now",
              errorMessage: null,
            })),
          });
        }
        return fixture(input);
      }),
    );
    const { result } = renderHook(() => useCatalogue(auth));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    act(() => {
      for (let id = 0; id < 150; id += 1) result.current.trackPendingCapture(String(id));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(batches).toHaveLength(2);
    expect(batches.every((batch) => batch.length === 100)).toBe(true);
    expect(new Set(batches.flat()).size).toBe(150);
  });
  it("changing inventory filters retains known work and does not reload the shared directories", async () => {
    vi.useFakeTimers();
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        requests.push(pathOf(input));
        return fixture(input);
      }),
    );
    const { result, rerender } = renderHook(
      ({ path }) => useCatalogue(auth, { ...inventoryOptions, inventoryPath: path }),
      { initialProps: { path: "/api/bottles?limit=50" } },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    act(() => {
      result.current.trackPendingCapture("pending-before-filter");
    });
    requests.length = 0;
    rerender({ path: "/api/bottles?limit=50&query=Shiraz" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(requests).toContain("/api/bottle-capture-statuses");
    expect(requests).not.toContain("/api/sites");
    expect(requests).not.toContain("/api/storage-locations");
  });
  it("a known import refreshes the current query after filters change during its compact poll", async () => {
    vi.useFakeTimers();
    let resolveStatus: ((response: Response) => void) | undefined;
    const requests: URL[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
          window.location.origin,
        );
        requests.push(url);
        if (url.pathname === "/api/bottle-capture-statuses")
          return new Promise<Response>((resolve) => {
            resolveStatus = resolve;
          });
        return fixture(input);
      }),
    );
    const { result, rerender } = renderHook(
      ({ path }) => useCatalogue(auth, { ...inventoryOptions, inventoryPath: path }),
      { initialProps: { path: "/api/bottles?query=old" } },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    act(() => {
      result.current.trackPendingCapture("tracked");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(resolveStatus).toBeDefined();
    rerender({ path: "/api/bottles?query=new" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      resolveStatus?.(
        response({
          data: [{ id: "tracked", status: "imported", updatedAt: "later", errorMessage: null }],
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(
      requests.filter(
        (request) =>
          request.pathname === "/api/bottles" && request.searchParams.get("query") === "new",
      ),
    ).toHaveLength(2);
    expect(
      requests.filter(
        (request) =>
          request.pathname === "/api/bottles" && request.searchParams.get("query") === "old",
      ),
    ).toHaveLength(1);
  });
});

it.each(["add", "edit", "delete", "capture"] as const)(
  "keeps a confirmed %s successful when a real catalogue refresh fails",
  async (action) => {
    const bottle = bottles[0];
    if (bottle === undefined) throw new Error("Expected bottle fixture");
    let committed = false;
    const mutations: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const path = pathOf(input);
        if (init?.method !== undefined) {
          mutations.push(init.method);
          committed = true;
          return init.method === "DELETE"
            ? new Response(null, { status: 204 })
            : response({
                data: { id: bottle.id, captureId: "confirmed-capture", intakeComplete: true },
              });
        }
        if (path === `/api/bottles/${bottle.id}`) return response({ data: bottle });
        if (committed && path === "/api/sites") return new Response(null, { status: 503 });
        return fixture(input);
      }),
    );
    const { result } = renderHook(() => {
      const catalogue = useCatalogue(auth);
      const shared = {
        additionScope: `refresh-failure-${action}`,
        completeMutation: catalogue.completeMutation,
        getAuthHeaders: auth,
        setStatus: catalogue.setStatus,
        writableSites: catalogue.sites,
      };
      return {
        catalogue,
        bottle: useBottleController({ ...shared, locations: catalogue.locations }),
        capture: useCaptureController(shared),
      };
    });
    await waitFor(() => {
      expect(result.current.catalogue.isLoading).toBe(false);
    });
    await act(async () => {
      if (action === "add")
        expect(
          await result.current.bottle.saveBottle({
            kind: "add",
            form: { ...initialFormState, siteId: "site-owner", wineryName: "Estate" },
          }),
        ).toEqual({ ok: true });
      else if (action === "edit") {
        await result.current.bottle.openBottleDetails(bottle);
      } else if (action === "delete")
        expect(await result.current.bottle.deleteBottle(bottle.id)).toBe(true);
      else
        expect(
          (
            await result.current.capture.submitCapture(
              { ...initialCaptureFormState, siteId: "site-owner" },
              [],
            )
          ).kind,
        ).toBe("submitted");
    });
    if (action === "edit") {
      await act(async () => {
        expect(
          await result.current.bottle.saveBottleEdit({
            kind: "edit-bottle",
            bottle: { notes: "Saved" },
          }),
        ).toEqual({ ok: true });
      });
      expect(result.current.bottle.selectedBottle?.id).toBe(bottle.id);
    }
    expect(mutations).toHaveLength(1);
    expect(result.current.catalogue.status).toContain("Latest data could not be refreshed.");
    expect(result.current.catalogue.refreshIssues).toContainEqual({
      collection: "sites",
      message: "Sites could not be refreshed. Try again.",
    });
  },
);
