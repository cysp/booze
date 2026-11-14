import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { bottles, captures, locations, sites } from "../e2e/catalogue-fixtures.ts";
import { useCatalogue } from "./useCatalogue.ts";

const dataByPath = new Map<string, readonly unknown[]>([
  ["/api/bottles", bottles],
  ["/api/wines", bottles],
  ["/api/bottle-captures", captures],
  ["/api/storage-locations", locations],
  ["/api/sites", sites],
]);

async function getAuthHeaders(): Promise<Record<string, string>> {
  return {};
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useCatalogue", () => {
  it("loads wine options independently of stock and retains a failed wine refresh until retried", async () => {
    const wine = { ...bottles[0], wineVintageId: "depleted-wine" };
    let failWines = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const path = requestPath(input);
        if (path === "/api/bottles") return jsonResponse([]);
        if (path === "/api/wines")
          return failWines ? new Response(null, { status: 503 }) : jsonResponse([wine]);
        return jsonResponse(dataByPath.get(path) ?? []);
      }),
    );
    const { result } = renderHook(() => useCatalogue(getAuthHeaders));
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    expect(result.current.items).toEqual([]);
    expect(result.current.wines.map((option) => option.wineVintageId)).toEqual(["depleted-wine"]);
    failWines = true;
    await act(async () =>
      result.current.completeMutation({ refresh: "catalogue", successMessage: "Saved." }),
    );
    expect(result.current.refreshIssues).toContainEqual({
      collection: "wines",
      message: "Wines could not be refreshed. Try again.",
    });
    expect(result.current.wines.map((option) => option.wineVintageId)).toEqual(["depleted-wine"]);
    await act(async () =>
      result.current.completeMutation({ refresh: "captures", successMessage: "Capture saved." }),
    );
    expect(result.current.refreshIssues).toHaveLength(1);
    failWines = false;
    await act(async () => result.current.retryRefresh("wines"));
    expect(result.current.refreshIssues).toEqual([]);
  });

  it("rejects an incomplete wine response instead of exposing a silently partial choice list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const path = requestPath(input);
        return jsonResponse(
          path === "/api/wines"
            ? [bottles[0], { wineVintageId: "malformed" }]
            : (dataByPath.get(path) ?? []),
        );
      }),
    );
    const { result } = renderHook(() => useCatalogue(getAuthHeaders));
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    expect(result.current.wines).toEqual([]);
    expect(result.current.refreshIssues).toEqual([
      { collection: "wines", message: "Wines could not be refreshed. Try again." },
    ]);
  });

  it("preserves historical saved review values without applying new-entry limits on reads", async () => {
    const reviewCandidate = {
      wine: {
        wineryName: "Historical estate",
        designation: null,
        baseName: null,
        displayName: null,
        alcoholPercent: 140,
        vintageYear: 1700,
      },
      bottle: { volumeMl: 75000 },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const request = requestPath(input);
        return jsonResponse(
          request === "/api/bottle-captures"
            ? [{ ...captures[0], reviewCandidate }]
            : (dataByPath.get(request) ?? []),
        );
      }),
    );
    const { result } = renderHook(() => useCatalogue(getAuthHeaders));
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    expect(result.current.refreshIssues).toEqual([]);
    expect(result.current.captures[0]?.reviewCandidate).toEqual(reviewCandidate);
  });

  it.each([
    {
      collection: "inventory",
      path: "/api/bottles",
      malformed: { ...bottles[0], volumeMl: "750" },
    },
    {
      collection: "inventory",
      path: "/api/bottles",
      malformed: { ...bottles[0], grapeVarieties: [7] },
    },
    {
      collection: "locations",
      path: "/api/storage-locations",
      malformed: { ...locations[0], parentId: 9 },
    },
    { collection: "sites", path: "/api/sites", malformed: { ...sites[0], bottleCount: "three" } },
    {
      collection: "captures",
      path: "/api/bottle-captures",
      malformed: { ...captures[0], images: [{ imageAssetId: "only-one-field" }] },
    },
    {
      collection: "captures",
      path: "/api/bottle-captures",
      malformed: {
        ...captures[0],
        reviewCandidate: {
          wine: { wineryName: "Estate", designation: "", alcoholPercent: "thirteen" },
          bottle: {},
        },
      },
    },
  ] as const)(
    "rejects malformed $collection before exposing a claimed resource shape",
    async ({ collection, path, malformed }) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request) => {
          const request = requestPath(input);
          return jsonResponse(request === path ? [malformed] : (dataByPath.get(request) ?? []));
        }),
      );
      const { result } = renderHook(() => useCatalogue(getAuthHeaders));
      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });
      expect(result.current.refreshIssues.map((issue) => issue.collection)).toEqual([collection]);
      const loaded = {
        inventory: result.current.items,
        locations: result.current.locations,
        sites: result.current.sites,
        captures: result.current.captures,
      };
      expect(loaded[collection]).toEqual([]);
    },
  );

  it("keeps a newer capture failure after an older catalogue refresh finishes", async () => {
    let inventoryRequests = 0;
    let resolveOldInventory: ((response: Response) => void) | undefined;
    let failCaptures = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const path = requestPath(input);
        if (path === "/api/bottles") {
          inventoryRequests += 1;
          if (inventoryRequests === 2)
            return new Promise<Response>((resolve) => {
              resolveOldInventory = resolve;
            });
        }
        if (path === "/api/bottle-captures") {
          if (failCaptures) return new Response(null, { status: 503 });
          return jsonResponse(captures.map((capture) => ({ ...capture, status: "needs_review" })));
        }
        return jsonResponse(dataByPath.get(path) ?? []);
      }),
    );
    const { result } = renderHook(() => useCatalogue(getAuthHeaders));
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    let older: Promise<void> = Promise.resolve();
    await act(async () => {
      older = result.current.completeMutation({
        refresh: "catalogue",
        successMessage: "Older bottle save.",
      });
    });
    failCaptures = true;
    // Represents a successful DELETE followed by its failed read refresh.
    await act(async () => {
      await result.current.completeMutation({
        refresh: "captures",
        successMessage: "Capture deleted.",
      });
    });
    expect(result.current.refreshIssues).toEqual([
      { collection: "captures", message: "Captures could not be refreshed. Try again." },
    ]);
    expect(result.current.captures).toHaveLength(captures.length);
    await act(async () => {
      resolveOldInventory?.(jsonResponse(bottles));
      await older;
    });
    // The newer failure retains its retry affordance and status.
    expect(result.current.captures).toHaveLength(captures.length);
    expect(result.current.refreshIssues).toContainEqual({
      collection: "captures",
      message: "Captures could not be refreshed. Try again.",
    });
    expect(result.current.status).toBe("Capture deleted. Latest data could not be refreshed.");
  });

  it("keeps independent section failures until that section succeeds and retries only the selected section", async () => {
    const failedPaths = new Set<string>();
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const path = requestPath(input);
        requests.push(path);
        return failedPaths.has(path)
          ? new Response(null, { status: 503 })
          : jsonResponse(dataByPath.get(path) ?? []);
      }),
    );
    const { result } = renderHook(() => useCatalogue(getAuthHeaders));
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    expect(result.current.status).toBe("Cellar data loaded.");

    failedPaths.add("/api/bottles");
    failedPaths.add("/api/sites");
    await act(async () => {
      await result.current.completeMutation({
        refresh: "catalogue",
        successMessage: "Bottle saved.",
      });
    });
    const inventoryIssue = {
      collection: "inventory",
      message: "Inventory could not be refreshed. Try again.",
    };
    const siteIssue = { collection: "sites", message: "Sites could not be refreshed. Try again." };
    expect(result.current.refreshIssues).toEqual(
      expect.arrayContaining([inventoryIssue, siteIssue]),
    );
    expect(result.current.refreshIssues).toHaveLength(2);
    await act(async () => {
      await result.current.completeMutation({
        refresh: "captures",
        successMessage: "Capture deleted.",
      });
    });
    expect(result.current.refreshIssues).toEqual(
      expect.arrayContaining([inventoryIssue, siteIssue]),
    );
    expect(result.current.status).toBe("Capture deleted.");

    failedPaths.delete("/api/sites");
    requests.length = 0;
    await act(async () => {
      await result.current.retryRefresh("sites");
    });
    expect(requests).toEqual(["/api/sites"]);
    expect(result.current.refreshIssues).toEqual([inventoryIssue]);
    expect(result.current.status).toBe("Latest data refreshed.");

    failedPaths.clear();
    requests.length = 0;
    await act(async () => {
      await result.current.retryRefresh();
    });
    expect(requests).toEqual(["/api/bottles"]);
    expect(result.current.refreshIssues).toEqual([]);
  });

  it("lets an older retry repair its own section without replacing a newer mutation failure", async () => {
    let failSites = true;
    let failCaptures = false;
    let resolveSiteRetry: ((response: Response) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const path = requestPath(input);
        if (path === "/api/sites") {
          if (failSites) return new Response(null, { status: 503 });
          return new Promise<Response>((resolve) => {
            resolveSiteRetry = resolve;
          });
        }
        if (path === "/api/bottle-captures" && failCaptures)
          return new Response(null, { status: 503 });
        return jsonResponse(dataByPath.get(path) ?? []);
      }),
    );
    const { result } = renderHook(() => useCatalogue(getAuthHeaders));
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    failSites = false;
    let retry = Promise.resolve();
    await act(async () => {
      retry = result.current.retryRefresh("sites");
    });
    failCaptures = true;
    await act(async () => {
      await result.current.completeMutation({
        refresh: "captures",
        successMessage: "Capture deleted.",
      });
    });
    await act(async () => {
      resolveSiteRetry?.(jsonResponse(sites));
      await retry;
    });
    expect(result.current.refreshIssues).toEqual([
      { collection: "captures", message: "Captures could not be refreshed. Try again." },
    ]);
    expect(result.current.status).toBe("Capture deleted. Latest data could not be refreshed.");
  });

  it("ignores stale retry success after a newer request for the same section fails", async () => {
    let captureRequests = 0;
    let resolveRetry: ((response: Response) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const path = requestPath(input);
        if (path === "/api/bottle-captures") {
          captureRequests += 1;
          if (captureRequests === 2)
            return new Promise<Response>((resolve) => {
              resolveRetry = resolve;
            });
          return new Response(null, { status: 503 });
        }
        return jsonResponse(dataByPath.get(path) ?? []);
      }),
    );
    const { result } = renderHook(() => useCatalogue(getAuthHeaders));
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    let retry = Promise.resolve();
    await act(async () => {
      retry = result.current.retryRefresh("captures");
    });
    await act(async () => {
      await result.current.completeMutation({
        refresh: "captures",
        successMessage: "Capture deleted.",
      });
    });
    await act(async () => {
      resolveRetry?.(jsonResponse(captures));
      await retry;
    });
    expect(result.current.captures).toEqual([]);
    expect(result.current.refreshIssues).toEqual([
      { collection: "captures", message: "Captures could not be refreshed. Try again." },
    ]);
    expect(result.current.status).toBe("Capture deleted. Latest data could not be refreshed.");
  });

  it("does not replace a newer action's progress message when an older retry finishes", async () => {
    let siteRequests = 0;
    let resolveRetry: ((response: Response) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const path = requestPath(input);
        if (path === "/api/sites") {
          siteRequests += 1;
          if (siteRequests === 1) return new Response(null, { status: 503 });
          return new Promise<Response>((resolve) => {
            resolveRetry = resolve;
          });
        }
        return jsonResponse(dataByPath.get(path) ?? []);
      }),
    );
    const { result } = renderHook(() => useCatalogue(getAuthHeaders));
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    let retry = Promise.resolve();
    await act(async () => {
      retry = result.current.retryRefresh("sites");
    });
    act(() => {
      result.current.setStatus("Saving another bottle...");
    });
    await act(async () => {
      resolveRetry?.(jsonResponse(sites));
      await retry;
    });
    expect(result.current.refreshIssues).toEqual([]);
    expect(result.current.status).toBe("Saving another bottle...");
  });

  it("keeps saved feedback when a background capture refresh repairs an already-failed aggregate leg", async () => {
    let inventoryRequests = 0;
    let failCaptures = false;
    let resolveInventory: ((response: Response) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const path = requestPath(input);
        if (path === "/api/bottles") {
          inventoryRequests += 1;
          if (inventoryRequests === 2)
            return new Promise<Response>((resolve) => {
              resolveInventory = resolve;
            });
        }
        if (path === "/api/bottle-captures" && failCaptures)
          return new Response(null, { status: 503 });
        return jsonResponse(dataByPath.get(path) ?? []);
      }),
    );
    const { result } = renderHook(() => useCatalogue(getAuthHeaders));
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    failCaptures = true;
    let completion = Promise.resolve();
    await act(async () => {
      completion = result.current.completeMutation({
        refresh: "catalogue",
        successMessage: "Bottle saved.",
      });
    });
    expect(result.current.refreshIssues).toEqual([
      { collection: "captures", message: "Captures could not be refreshed. Try again." },
    ]);
    failCaptures = false;
    await act(async () => {
      await result.current.loadCaptures();
    });
    await act(async () => {
      resolveInventory?.(jsonResponse(bottles));
      await completion;
    });
    expect(result.current.refreshIssues).toEqual([]);
    expect(result.current.status).toBe("Bottle saved.");
  });

  it("pauses capture polling in hidden tabs and refreshes immediately on return", async () => {
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const path = requestPath(input);
        requests.push(path);
        return jsonResponse(
          path === "/api/bottle-captures"
            ? captures.map((capture) => ({ ...capture, status: "queued" }))
            : (dataByPath.get(path) ?? []),
        );
      }),
    );
    renderHook(() => useCatalogue(getAuthHeaders));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    requests.length = 0;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(requests).toEqual([]);

    visibility.mockReturnValue("visible");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(requests).toEqual(["/api/bottle-captures"]);
  });

  it("does not replace newer inventory with an older overlapping response", async () => {
    let resolveInitialInventory: ((response: Response) => void) | undefined;
    let requestedInventory = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const path = requestPath(input);
        if (path === "/api/bottles") {
          if (!requestedInventory) {
            requestedInventory = true;
            return new Promise<Response>((resolve) => {
              resolveInitialInventory = resolve;
            });
          }
          return jsonResponse(bottles.map((bottle) => ({ ...bottle, bottleNotes: "Newer fact" })));
        }
        return jsonResponse(dataByPath.get(path) ?? []);
      }),
    );
    const { result } = renderHook(() => useCatalogue(getAuthHeaders));
    await waitFor(() => {
      expect(requestedInventory).toBe(true);
    });
    await act(async () => {
      await result.current.loadCatalogue();
    });
    expect(result.current.items[0]?.bottleNotes).toBe("Newer fact");

    await act(async () => {
      resolveInitialInventory?.(jsonResponse(bottles));
    });
    expect(result.current.items[0]?.bottleNotes).toBe("Newer fact");
  });

  it("ignores an older load failure after a newer refresh succeeds", async () => {
    let rejectInitialInventory: ((error: Error) => void) | undefined;
    let requestedInventory = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const path = requestPath(input);
        if (path === "/api/bottles" && !requestedInventory) {
          requestedInventory = true;
          return new Promise<Response>((_resolve, reject) => {
            rejectInitialInventory = reject;
          });
        }
        return jsonResponse(dataByPath.get(path) ?? []);
      }),
    );
    const { result } = renderHook(() => useCatalogue(getAuthHeaders));
    await waitFor(() => {
      expect(requestedInventory).toBe(true);
    });
    await act(async () => {
      await result.current.completeMutation({
        refresh: "catalogue",
        successMessage: "Bottle saved.",
      });
    });
    await act(async () => {
      rejectInitialInventory?.(new Error("An older request lost its connection"));
    });

    expect(result.current.items).toHaveLength(1);
    expect(result.current.refreshIssues).toEqual([]);
    expect(result.current.status).toBe("Bottle saved.");
  });

  it("does not clear a newer refresh failure when an older load finishes", async () => {
    let resolveInitialInventory: ((response: Response) => void) | undefined;
    let requestedInventory = false;
    let failSites = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const path = requestPath(input);
        if (path === "/api/bottles" && !requestedInventory) {
          requestedInventory = true;
          return new Promise<Response>((resolve) => {
            resolveInitialInventory = resolve;
          });
        }
        return path === "/api/sites" && failSites
          ? new Response(null, { status: 503 })
          : jsonResponse(dataByPath.get(path) ?? []);
      }),
    );
    const { result } = renderHook(() => useCatalogue(getAuthHeaders));
    await waitFor(() => {
      expect(requestedInventory).toBe(true);
    });
    failSites = true;
    await act(async () => {
      await result.current.completeMutation({
        refresh: "catalogue",
        successMessage: "Bottle saved.",
      });
    });
    await act(async () => {
      resolveInitialInventory?.(jsonResponse(bottles));
    });

    expect(result.current.refreshIssues).toEqual([
      {
        collection: "sites",
        message: "Sites could not be refreshed. Try again.",
      },
    ]);
  });

  it("ignores an older polling failure after a catalogue refresh succeeds", async () => {
    vi.useFakeTimers();
    let captureRequests = 0;
    let rejectPoll: ((error: Error) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const path = requestPath(input);
        if (path === "/api/bottle-captures") {
          captureRequests += 1;
          if (captureRequests === 2) {
            return new Promise<Response>((_resolve, reject) => {
              rejectPoll = reject;
            });
          }
          return jsonResponse(captures.map((capture) => ({ ...capture, status: "extracting" })));
        }
        return jsonResponse(dataByPath.get(path) ?? []);
      }),
    );
    const { result } = renderHook(() => useCatalogue(getAuthHeaders));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(captureRequests).toBe(2);
    await act(async () => {
      await result.current.completeMutation({
        refresh: "catalogue",
        successMessage: "Bottle saved.",
      });
    });
    await act(async () => {
      rejectPoll?.(new Error("An older polling request lost its connection"));
    });

    expect(result.current.refreshIssues).toEqual([]);
    expect(result.current.status).toBe("Bottle saved.");
  });

  it("offers a retry after the initial catalogue load fails", async () => {
    let unavailable = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) =>
        unavailable
          ? new Response(null, { status: 503 })
          : jsonResponse(dataByPath.get(requestPath(input)) ?? []),
      ),
    );
    const { result } = renderHook(() => useCatalogue(getAuthHeaders));
    await waitFor(() => {
      expect(result.current.refreshIssues.map((issue) => issue.collection).toSorted()).toEqual([
        "captures",
        "inventory",
        "locations",
        "sites",
        "wines",
      ]);
    });

    unavailable = false;
    await act(async () => {
      await result.current.retryRefresh();
    });

    expect(result.current.items).toHaveLength(1);
    expect(result.current.refreshIssues).toEqual([]);
  });

  it("refreshes pending captures, updates imported inventory, and stops after processing finishes", async () => {
    vi.useFakeTimers();
    let captureStatus = "queued";
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const path = requestPath(input);
        requests.push(path);
        return jsonResponse(
          path === "/api/bottle-captures"
            ? captures.map((capture) => ({ ...capture, status: captureStatus }))
            : (dataByPath.get(path) ?? []),
        );
      }),
    );
    const { result } = renderHook(() => useCatalogue(getAuthHeaders));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.captures[0]?.status).toBe("queued");
    requests.length = 0;

    captureStatus = "extracting";
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(requests).toEqual(["/api/bottle-captures"]);
    expect(result.current.captures[0]?.status).toBe("extracting");

    captureStatus = "imported";
    requests.length = 0;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(requests).toContain("/api/bottles");
    expect(result.current.captures[0]?.status).toBe("imported");
    expect(result.current.status).toBe("Capture imported. Inventory updated.");

    requests.length = 0;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(requests).toEqual([]);
  });

  it("retains pending captures through temporary polling failure and clears the warning on recovery", async () => {
    vi.useFakeTimers();
    let unavailable = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const path = requestPath(input);
        if (path === "/api/bottle-captures") {
          return unavailable
            ? new Response(null, { status: 503 })
            : jsonResponse(captures.map((capture) => ({ ...capture, status: "extracting" })));
        }
        return jsonResponse(dataByPath.get(path) ?? []);
      }),
    );
    const { result } = renderHook(() => useCatalogue(getAuthHeaders));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    unavailable = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(result.current.captures[0]?.status).toBe("extracting");
    expect(result.current.refreshIssues).toContainEqual({
      collection: "captures",
      message: "Captures could not be refreshed. Try again.",
    });

    unavailable = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(result.current.refreshIssues).toEqual([]);
  });

  it("keeps a committed mutation successful and retries only its failed refresh", async () => {
    let failedPath: string | null = null;
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const path = requestPath(input);
        requests.push(path);
        if (path === failedPath) {
          return new Response(null, { status: 503 });
        }
        return jsonResponse(dataByPath.get(path) ?? []);
      }),
    );

    const { result } = renderHook(() => useCatalogue(getAuthHeaders));
    await waitFor(() => {
      expect(result.current.items).toHaveLength(1);
    });

    failedPath = "/api/sites";
    await act(async () => {
      await result.current.completeMutation({
        refresh: "catalogue",
        successMessage: "Bottle saved.",
      });
    });

    expect(result.current.status).toBe("Bottle saved. Latest data could not be refreshed.");
    expect(result.current.refreshIssues).toEqual([
      {
        collection: "sites",
        message: "Sites could not be refreshed. Try again.",
      },
    ]);

    failedPath = null;
    requests.length = 0;
    await act(async () => {
      await result.current.retryRefresh();
    });

    expect(requests).toEqual(["/api/sites"]);
    expect(result.current.refreshIssues).toEqual([]);
    expect(result.current.status).toBe("Latest data refreshed.");
  });

  it("limits capture recovery to capture data and retains a retry after repeated failure", async () => {
    let failCaptures = false;
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const path = requestPath(input);
        requests.push(path);
        if (failCaptures && path === "/api/bottle-captures") {
          return new Response(null, { status: 503 });
        }
        return jsonResponse(dataByPath.get(path) ?? []);
      }),
    );

    const { result } = renderHook(() => useCatalogue(getAuthHeaders));
    await waitFor(() => {
      expect(result.current.captures).toHaveLength(1);
    });

    failCaptures = true;
    requests.length = 0;
    await act(async () => {
      await result.current.completeMutation({
        refresh: "captures",
        successMessage: "Capture deleted.",
      });
    });

    expect(requests).toEqual(["/api/bottle-captures"]);
    expect(result.current.refreshIssues).toContainEqual({
      collection: "captures",
      message: "Captures could not be refreshed. Try again.",
    });

    requests.length = 0;
    await act(async () => {
      await result.current.retryRefresh();
    });

    expect(requests).toEqual(["/api/bottle-captures"]);
    expect(result.current.refreshIssues).toContainEqual({
      collection: "captures",
      message: "Captures could not be refreshed. Try again.",
    });
    expect(result.current.status).toBe("Latest data is still unavailable. Try refreshing again.");
  });
});

function requestPath(input: string | URL | Request): string {
  if (input instanceof Request) {
    return new URL(input.url, window.location.origin).pathname;
  }
  return new URL(String(input), window.location.origin).pathname;
}

function jsonResponse(data: readonly unknown[]): Response {
  return new Response(JSON.stringify({ data }), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}
