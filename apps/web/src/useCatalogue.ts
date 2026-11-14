import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { z } from "zod";
import {
  siteResourceSchema,
  storageLocationResourceSchema,
} from "../shared/catalogue-resources.ts";
import type { InventoryPage } from "../shared/inventory-queries.ts";
import type { CatalogueSummary } from "../shared/catalogue-summary.ts";
import type { CapturePage, CaptureSummary } from "../shared/capture-read-resources.ts";
import { inventoryPageSchema } from "../shared/inventory-queries.ts";
import { catalogueSummarySchema } from "../shared/catalogue-summary.ts";

import { isProcessingCaptureStatus } from "../shared/capture-status.ts";
import {
  inventorySummaryItem,
  type Area,
  type InventorySummaryItem,
  type LocationItem,
  type SiteItem,
} from "./inventory-model.ts";
import {
  useReadPage,
  type AuthHeadersProvider,
  type RefreshResult,
  type ReadPageController,
} from "./useReadPage.ts";

const loadCapturePageSchema = async () =>
  (await import("../shared/capture-read-resources.ts")).capturePageSchema;

type CollectionName =
  | "inventory"
  | "locations"
  | "sites"
  | "captures"
  | "summary"
  | "capture-statuses";
export type MutationCompletion = {
  readonly refresh: "captures" | "catalogue";
  readonly successMessage: string;
};
export type RefreshIssue = { readonly collection: CollectionName; readonly message: string };
type Options = {
  readonly area: Area;
  readonly inventoryPath: string;
  readonly captureView: "action" | "all";
};
const defaultOptions: Options = {
  area: "inventory",
  inventoryPath: "/api/bottles?limit=50",
  captureView: "action",
};
const emptySummary = {
  inStockBottleCount: 0,
  drinkQueueBottleCount: 0,
  captures: { actionable: 0, processing: 0, imported: 0 },
};
const lightNames = ["locations", "sites", "summary"] as const;
type LightName = (typeof lightNames)[number];

type CatalogueController = {
  readonly inventory: ReadPageController<InventoryPage>;
  readonly capturePage: ReadPageController<CapturePage>;
  readonly captures: readonly CaptureSummary[];
  readonly items: readonly InventorySummaryItem[];
  readonly locations: readonly LocationItem[];
  readonly sites: readonly SiteItem[];
  readonly summary: CatalogueSummary;
  readonly completeMutation: (completion: MutationCompletion) => Promise<void>;
  readonly isLoading: boolean;
  readonly refreshIssues: readonly RefreshIssue[];
  readonly retryRefresh: (collection?: CollectionName) => Promise<void>;
  readonly status: string;
  readonly setStatus: Dispatch<SetStateAction<string>>;
  readonly trackPendingCapture: (id: string) => void;
};

/** Shared ownership is limited to small navigation resources, mutation feedback, and known work. */
export function useCatalogue(
  getAuthHeaders: AuthHeadersProvider,
  options: Options = defaultOptions,
): CatalogueController {
  const [locations, setLocations] = useState<readonly LocationItem[]>([]);
  const [sites, setSites] = useState<readonly SiteItem[]>([]);
  const [summary, setSummary] = useState(emptySummary);
  const [isLoadingShared, setIsLoadingShared] = useState(true);
  const [status, setStatusValue] = useState("Loading cellar data...");
  const [issues, setIssues] = useState<Partial<Record<CollectionName, string>>>({});
  const versions = useRef({ locations: 0, sites: 0, summary: 0, statuses: 0 });
  const statusVersion = useRef(0);
  const auth = useRef(getAuthHeaders);
  auth.current = getAuthHeaders;
  const inventory = useReadPage({
    active: options.area === "inventory",
    getAuthHeaders,
    path: options.inventoryPath,
    schema: inventoryPageSchema,
  });
  const latestInventoryRefresh = useRef(inventory.refresh);
  latestInventoryRefresh.current = inventory.refresh;
  const capturePage = useReadPage({
    active: options.area === "captures",
    getAuthHeaders,
    path: `/api/bottle-captures?view=${options.captureView}&limit=50`,
    schema: loadCapturePageSchema,
  });
  const latestCaptureRefresh = useRef(capturePage.refresh);
  latestCaptureRefresh.current = capturePage.refresh;
  const knownPending = useRef(new Map<string, string>());
  const pollOffset = useRef(0);
  const hasLoadedSummary = useRef(false);
  const summaryRef = useRef(summary);
  summaryRef.current = summary;
  const [pendingVersion, setPendingVersion] = useState(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const setStatus = useCallback((value: SetStateAction<string>): void => {
    statusVersion.current += 1;
    setStatusValue(value);
  }, []);
  const setIssue = useCallback((name: CollectionName, message: string | undefined): void => {
    setIssues((current) => ({ ...current, [name]: message }));
  }, []);
  const loadLight = useCallback(
    async (name: LightName, invalidateInventory = false): Promise<RefreshResult> => {
      versions.current[name] += 1;
      const version = versions.current[name];
      const current = () =>
        mounted.current && auth.current === getAuthHeaders && version === versions.current[name];
      try {
        const path =
          name === "locations"
            ? "/api/storage-locations"
            : name === "sites"
              ? "/api/sites"
              : "/api/catalogue-summary";
        const response = await fetch(path, { headers: await getAuthHeaders() });
        if (!response.ok) throw new Error("Read failed");
        const payload: unknown = await response.json();
        if (name === "locations") {
          const data = z
            .object({ data: z.array(storageLocationResourceSchema) })
            .parse(payload).data;
          if (current()) setLocations(data);
        } else if (name === "sites") {
          const data = z.object({ data: z.array(siteResourceSchema) }).parse(payload).data;
          if (current()) setSites(data);
        } else {
          const data = catalogueSummarySchema.parse(payload).data;
          if (current()) {
            if (
              invalidateInventory &&
              hasLoadedSummary.current &&
              (summaryRef.current.captures.processing > data.captures.processing ||
                summaryRef.current.captures.imported !== data.captures.imported)
            )
              void (async () => {
                try {
                  await latestInventoryRefresh.current();
                } catch {
                  /* Inventory owns its refresh warning. */
                }
              })();
            hasLoadedSummary.current = true;
            summaryRef.current = data;
            setSummary(data);
          }
        }
        if (!current()) return "superseded";
        setIssue(name, undefined);
        return "refreshed";
      } catch (cause) {
        if (!current()) return "superseded";
        setIssue(
          name,
          `${name === "locations" ? "Locations" : name === "sites" ? "Sites" : "Cellar summary"} could not be refreshed. Try again.`,
        );
        throw cause;
      }
    },
    [getAuthHeaders, setIssue],
  );
  const refresh = useCallback(
    async (scope: MutationCompletion["refresh"]): Promise<void> => {
      const requests: Promise<unknown>[] = [loadLight("summary")];
      if (scope === "catalogue") requests.push(loadLight("locations"), loadLight("sites"));
      if (options.area === "captures") requests.push(capturePage.refresh());
      if (scope === "catalogue" && options.area === "inventory") requests.push(inventory.refresh());
      const results = await Promise.allSettled(requests);
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    },
    [capturePage.refresh, inventory.refresh, loadLight, options.area],
  );
  // A confirmed mutation stays successful; this module owns refresh failures and retry feedback.
  const completeMutation = useCallback(
    async ({ refresh: scope, successMessage }: MutationCompletion): Promise<void> => {
      statusVersion.current += 1;
      const version = statusVersion.current;
      try {
        await refresh(scope);
        if (version === statusVersion.current && auth.current === getAuthHeaders && mounted.current)
          setStatusValue(successMessage);
      } catch {
        if (version === statusVersion.current && auth.current === getAuthHeaders && mounted.current)
          setStatusValue(`${successMessage} Latest data could not be refreshed.`);
      }
    },
    [getAuthHeaders, refresh],
  );
  const trackPendingCapture = useCallback(
    (id: string): void => {
      if (!mounted.current || auth.current !== getAuthHeaders) return;
      versions.current.statuses += 1;
      knownPending.current.set(id, "pending");
      setPendingVersion((value) => value + 1);
    },
    [getAuthHeaders],
  );
  useEffect(() => {
    for (const capture of capturePage.page?.data ?? []) {
      if (isProcessingCaptureStatus(capture.status))
        knownPending.current.set(capture.id, `${capture.status}:${capture.updatedAt}`);
    }
    setPendingVersion((value) => value + 1);
  }, [capturePage.page]);

  const pollCaptures = useCallback(async (): Promise<void> => {
    if (document.visibilityState === "hidden") return;
    if (knownPending.current.size === 0) {
      if (summaryRef.current.captures.processing > 0) await loadLight("summary", true);
      return;
    }
    versions.current.statuses += 1;
    const version = versions.current.statuses;
    const current = () =>
      mounted.current && auth.current === getAuthHeaders && version === versions.current.statuses;
    const pendingIds = [...knownPending.current.keys()];
    const start = pollOffset.current % pendingIds.length;
    const ids = [...pendingIds.slice(start), ...pendingIds.slice(0, start)].slice(0, 100);
    pollOffset.current = start + ids.length;
    try {
      const snapshots = [];
      const query = new URLSearchParams(ids.map((id) => ["captureId", id]));
      const response = await fetch(`/api/bottle-capture-statuses?${query.toString()}`, {
        headers: await getAuthHeaders(),
      });
      if (!response.ok) throw new Error("Capture status read failed");
      const { captureStatusPageSchema } = await import("../shared/capture-read-resources.ts");
      snapshots.push(...captureStatusPageSchema.parse(await response.json()).data);
      if (!current()) return;
      const byId = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
      let invalidateInventory = false;
      let changed = false;
      for (const id of ids) {
        const snapshot = byId.get(id);
        if (snapshot === undefined) {
          knownPending.current.delete(id);
          invalidateInventory = true;
          changed = true;
        } else {
          const next = `${snapshot.status}:${snapshot.updatedAt}`;
          changed ||= knownPending.current.get(id) !== next;
          if (snapshot.status === "imported") {
            invalidateInventory = true;
          }
          if (isProcessingCaptureStatus(snapshot.status)) knownPending.current.set(id, next);
          else knownPending.current.delete(id);
        }
      }
      setIssue("capture-statuses", undefined);
      setPendingVersion((value) => value + 1);
      const requests: Promise<unknown>[] = [loadLight("summary", !invalidateInventory)];
      if (changed) requests.push(latestCaptureRefresh.current());
      if (invalidateInventory) requests.push(latestInventoryRefresh.current());
      await Promise.allSettled(requests);
    } catch (cause) {
      if (!current()) return;
      setIssue("capture-statuses", "Capture progress could not be refreshed. Try again.");
      throw cause;
    }
  }, [getAuthHeaders, loadLight, setIssue]);
  useEffect(() => {
    let stopped = false;
    let pending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll(): Promise<void> {
      if (stopped || pending) return;
      pending = true;
      try {
        await pollCaptures();
      } catch {
        /* Keep the retry warning and known IDs. */
      } finally {
        pending = false;
        if (
          !stopped &&
          (knownPending.current.size > 0 || summaryRef.current.captures.processing > 0)
        )
          timer = setTimeout(() => {
            void poll();
          }, 5_000);
      }
    }
    const onVisibility = () => {
      if (document.visibilityState !== "hidden") {
        clearTimeout(timer);
        void poll();
      }
    };
    if (knownPending.current.size > 0 || summary.captures.processing > 0) {
      timer = setTimeout(() => {
        void poll();
      }, 5_000);
      document.addEventListener("visibilitychange", onVisibility);
    }
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [pendingVersion, pollCaptures, summary.captures.processing]);
  useEffect(() => {
    statusVersion.current += 1;
    const version = statusVersion.current;
    setIsLoadingShared(true);
    setLocations([]);
    setSites([]);
    setSummary(emptySummary);
    setIssues({});
    knownPending.current.clear();
    hasLoadedSummary.current = false;
    void (async () => {
      const results = await Promise.allSettled(lightNames.map(async (name) => loadLight(name)));
      if (auth.current !== getAuthHeaders || !mounted.current) return;
      setIsLoadingShared(false);
      if (version === statusVersion.current)
        setStatusValue(
          results.some((result) => result.status === "rejected")
            ? "Could not load cellar data. Try refreshing."
            : "Cellar data loaded.",
        );
    })();
    return () => {
      for (const name of lightNames) versions.current[name] += 1;
      versions.current.statuses += 1;
    };
  }, [getAuthHeaders, loadLight]);
  const retryRefresh = useCallback(
    async (collection?: CollectionName): Promise<void> => {
      statusVersion.current += 1;
      const version = statusVersion.current;
      setStatusValue("Refreshing latest data...");
      const requests: Promise<unknown>[] = lightNames
        .filter(
          (name) => issues[name] !== undefined && (collection === undefined || collection === name),
        )
        .map(async (name) => loadLight(name));
      if (inventory.error !== null && (collection === undefined || collection === "inventory"))
        requests.push(inventory.refresh());
      if (capturePage.error !== null && (collection === undefined || collection === "captures"))
        requests.push(capturePage.refresh());
      if (
        issues["capture-statuses"] !== undefined &&
        (collection === undefined || collection === "capture-statuses")
      )
        requests.push(pollCaptures());
      const results = await Promise.allSettled(requests);
      if (version === statusVersion.current)
        setStatusValue(
          results.some((result) => result.status === "rejected")
            ? "Latest data is still unavailable. Try refreshing again."
            : "Latest data refreshed.",
        );
    },
    [
      capturePage.error,
      capturePage.refresh,
      inventory.error,
      inventory.refresh,
      issues,
      loadLight,
      pollCaptures,
    ],
  );
  const collectionNames: readonly CollectionName[] = [
    "inventory",
    "captures",
    "locations",
    "sites",
    "summary",
    "capture-statuses",
  ];
  const refreshIssues: RefreshIssue[] = collectionNames.flatMap((collection) => {
    const message = issues[collection];
    return message === undefined ? [] : [{ collection, message }];
  });
  if (inventory.error !== null && options.area === "inventory")
    refreshIssues.push({
      collection: "inventory",
      message: "Inventory could not be refreshed. Try again.",
    });
  if (capturePage.error !== null && options.area === "captures")
    refreshIssues.push({
      collection: "captures",
      message: "Captures could not be refreshed. Try again.",
    });
  return {
    inventory,
    capturePage,
    captures: capturePage.page?.data ?? [],
    items: inventory.page?.data.map(inventorySummaryItem) ?? [],
    completeMutation,
    isLoading: isLoadingShared || inventory.isLoading,
    locations,
    sites,
    summary,
    refreshIssues,
    retryRefresh,
    status,
    setStatus,
    trackPendingCapture,
  };
}
