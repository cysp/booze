import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

import {
  inventoryItem,
  type CaptureResource,
  type InventoryItem,
  type LocationItem,
  type SiteItem,
} from "./inventory-model.ts";

import { z } from "zod";
import {
  bottleResourceSchema,
  captureResourceSchema,
  siteResourceSchema,
  storageLocationResourceSchema,
} from "../shared/catalogue-resources.ts";
import { wineOptionSchema, type WineOption } from "../shared/wine-options.ts";

type AuthHeadersProvider = () => Promise<Record<string, string>>;
type CollectionName = "inventory" | "locations" | "sites" | "captures" | "wines";
const collectionNames: readonly CollectionName[] = [
  "inventory",
  "locations",
  "sites",
  "captures",
  "wines",
];
type RefreshResult = "refreshed" | "superseded";
type CollectionRequest<Resource> = {
  readonly schema: z.ZodType<Resource>;
  readonly path: string;
  readonly resourceName: string;
};

export type MutationCompletion = {
  readonly refresh: "captures" | "catalogue";
  readonly successMessage: string;
};

export type RefreshIssue = {
  readonly collection: CollectionName;
  readonly message: string;
};

type CatalogueController = {
  readonly captures: readonly CaptureResource[];
  readonly completeMutation: (completion: MutationCompletion) => Promise<void>;
  readonly items: readonly InventoryItem[];
  readonly wines: readonly WineOption[];
  readonly isLoading: boolean;
  readonly loadCaptures: () => Promise<RefreshResult>;
  readonly loadCatalogue: () => Promise<RefreshResult>;
  readonly locations: readonly LocationItem[];
  readonly refreshIssues: readonly RefreshIssue[];
  readonly retryRefresh: (collection?: CollectionName) => Promise<void>;
  readonly sites: readonly SiteItem[];
  readonly status: string;
  readonly setStatus: Dispatch<SetStateAction<string>>;
};

export function useCatalogue(getAuthHeaders: AuthHeadersProvider): CatalogueController {
  const [isLoading, setIsLoading] = useState(true);
  const [items, setItems] = useState<readonly InventoryItem[]>([]);
  const [wines, setWines] = useState<readonly WineOption[]>([]);
  const [captures, setCaptures] = useState<readonly CaptureResource[]>([]);
  const [locations, setLocations] = useState<readonly LocationItem[]>([]);
  const [sites, setSites] = useState<readonly SiteItem[]>([]);
  const [status, setStatusValue] = useState("Loading inventory...");
  const [issuesByCollection, setIssuesByCollection] = useState<
    Partial<Record<CollectionName, RefreshIssue | undefined>>
  >({});
  const requestVersions = useRef({ inventory: 0, locations: 0, sites: 0, captures: 0, wines: 0 });
  const statusVersion = useRef(0);
  const previousCaptures = useRef<readonly CaptureResource[]>([]);
  const hasPendingCaptures = captures.some((capture) => isPendingCapture(capture));
  const setStatus = useCallback((value: SetStateAction<string>): void => {
    statusVersion.current += 1;
    setStatusValue(value);
  }, []);

  const loadLatestCollection = useCallback(
    async <Resource>(
      collection: CollectionName,
      request: CollectionRequest<Resource>,
    ): Promise<readonly Resource[] | null> => {
      requestVersions.current[collection] += 1;
      const requestVersion = requestVersions.current[collection];
      try {
        const data = await loadCollection({ ...request, getAuthHeaders });
        if (requestVersion !== requestVersions.current[collection]) return null;
        setIssuesByCollection((current) => {
          if (current[collection] === undefined) return current;
          return { ...current, [collection]: undefined };
        });
        return data;
      } catch (error) {
        if (requestVersion !== requestVersions.current[collection]) return null;
        setIssuesByCollection((current) => ({
          ...current,
          [collection]: {
            collection,
            message: `${request.resourceName} could not be refreshed. Try again.`,
          },
        }));
        throw error;
      }
    },
    [getAuthHeaders],
  );

  const loadInventory = useCallback(async (): Promise<RefreshResult> => {
    const data = await loadLatestCollection("inventory", {
      schema: bottleResourceSchema,
      path: "/api/bottles",
      resourceName: "Inventory",
    });
    if (data === null) return "superseded";
    const nextItems = data.map((item) => inventoryItem(item));
    setItems(nextItems);
    return "refreshed";
  }, [loadLatestCollection]);

  const loadWines = useCallback(async (): Promise<RefreshResult> => {
    const data = await loadLatestCollection("wines", {
      schema: wineOptionSchema,
      path: "/api/wines",
      resourceName: "Wines",
    });
    if (data === null) return "superseded";
    setWines(data);
    return "refreshed";
  }, [loadLatestCollection]);

  const loadLocations = useCallback(async (): Promise<RefreshResult> => {
    const data = await loadLatestCollection("locations", {
      schema: storageLocationResourceSchema,
      path: "/api/storage-locations",
      resourceName: "Locations",
    });
    if (data === null) return "superseded";
    setLocations(data);
    return "refreshed";
  }, [loadLatestCollection]);

  const loadSites = useCallback(async (): Promise<RefreshResult> => {
    const data = await loadLatestCollection("sites", {
      schema: siteResourceSchema,
      path: "/api/sites",
      resourceName: "Sites",
    });
    if (data === null) return "superseded";
    setSites(data);
    return "refreshed";
  }, [loadLatestCollection]);

  const loadCaptures = useCallback(async (): Promise<RefreshResult> => {
    const data = await loadLatestCollection("captures", {
      schema: captureResourceSchema,
      path: "/api/bottle-captures",
      resourceName: "Captures",
    });
    if (data === null) return "superseded";
    setCaptures(data);
    return "refreshed";
  }, [loadLatestCollection]);

  const loadCollections = useCallback(
    async (collections: readonly CollectionName[]): Promise<RefreshResult> => {
      const loaders = {
        inventory: loadInventory,
        wines: loadWines,
        locations: loadLocations,
        sites: loadSites,
        captures: loadCaptures,
      };
      const pending = collections.map((collection) => ({
        collection,
        promise: loaders[collection](),
        version: requestVersions.current[collection],
      }));
      const results = await Promise.allSettled(pending.map(async (request) => request.promise));
      let superseded = false;
      for (const [index, result] of results.entries()) {
        const request = pending[index];
        if (request === undefined) continue;
        // A collection can be refreshed again after its leg of this batch has
        // settled. Recheck at aggregate completion before reporting its outcome.
        if (request.version !== requestVersions.current[request.collection]) {
          superseded = true;
          continue;
        }
        if (result.status === "rejected") throw result.reason;
        if (result.value === "superseded") superseded = true;
      }
      return superseded ? "superseded" : "refreshed";
    },
    [loadCaptures, loadInventory, loadLocations, loadSites, loadWines],
  );

  const loadCatalogue = useCallback(
    async (): Promise<RefreshResult> => loadCollections(collectionNames),
    [loadCollections],
  );

  const refresh = useCallback(
    async (scope: MutationCompletion["refresh"]): Promise<RefreshResult> =>
      scope === "captures" ? loadCaptures() : loadCatalogue(),
    [loadCaptures, loadCatalogue],
  );

  const completeMutation = useCallback(
    async ({ refresh: scope, successMessage }: MutationCompletion): Promise<void> => {
      statusVersion.current += 1;
      const version = statusVersion.current;
      try {
        await refresh(scope);
        if (version === statusVersion.current) setStatusValue(successMessage);
      } catch {
        if (version === statusVersion.current) {
          setStatusValue(`${successMessage} Latest data could not be refreshed.`);
        }
      }
    },
    [refresh],
  );

  const retryRefresh = useCallback(
    async (collection?: CollectionName): Promise<void> => {
      const failed = collectionNames.filter(
        (name) =>
          issuesByCollection[name] !== undefined &&
          (collection === undefined || name === collection),
      );
      if (failed.length === 0) return;
      statusVersion.current += 1;
      const version = statusVersion.current;
      setStatusValue("Refreshing latest data...");
      try {
        await loadCollections(failed);
        if (version === statusVersion.current) setStatusValue("Latest data refreshed.");
      } catch {
        if (version === statusVersion.current) {
          setStatusValue("Latest data is still unavailable. Try refreshing again.");
        }
      }
    },
    [issuesByCollection, loadCollections],
  );

  useEffect(() => {
    async function load(): Promise<void> {
      statusVersion.current += 1;
      const version = statusVersion.current;
      try {
        await loadCatalogue();
        if (version === statusVersion.current) setStatusValue("Cellar data loaded.");
      } catch {
        if (version === statusVersion.current) {
          setStatusValue("Could not load cellar data. Try refreshing.");
        }
      } finally {
        setIsLoading(false);
      }
    }

    void load();
  }, [loadCatalogue]);

  useEffect(() => {
    let stopped = false;
    let pending = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    async function poll(): Promise<void> {
      if (stopped || pending) {
        return;
      }
      clearTimeout(timeout);
      pending = true;
      try {
        if (document.visibilityState !== "hidden") {
          await loadCaptures();
        }
      } catch {
        // The collection retains its warning until a current request succeeds.
      } finally {
        pending = false;
        if (!stopped) {
          timeout = setTimeout(() => {
            void poll();
          }, 5_000);
        }
      }
    }

    function onVisibilityChange(): void {
      if (document.visibilityState !== "hidden") {
        void poll();
      }
    }

    if (hasPendingCaptures) {
      timeout = setTimeout(() => {
        void poll();
      }, 5_000);
      document.addEventListener("visibilitychange", onVisibilityChange);
    }
    return () => {
      stopped = true;
      clearTimeout(timeout);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [hasPendingCaptures, loadCaptures]);

  useEffect(() => {
    const imported = captures.some(
      (capture) =>
        capture.status === "imported" &&
        previousCaptures.current.some(
          (previous) => previous.id === capture.id && isPendingCapture(previous),
        ),
    );
    previousCaptures.current = captures;
    if (imported) {
      void completeMutation({
        refresh: "catalogue",
        successMessage: "Capture imported. Inventory updated.",
      });
    }
  }, [captures, completeMutation]);

  return {
    captures,
    wines,
    completeMutation,
    items,
    isLoading,
    loadCaptures,
    loadCatalogue,
    locations,
    refreshIssues: collectionNames.flatMap((collection) => {
      const issue = issuesByCollection[collection];
      return issue === undefined ? [] : [issue];
    }),
    retryRefresh,
    sites,
    status,
    setStatus,
  };
}

async function loadCollection<Resource>({
  getAuthHeaders,
  schema,
  path,
  resourceName,
}: CollectionRequest<Resource> & {
  readonly getAuthHeaders: AuthHeadersProvider;
}): Promise<readonly Resource[]> {
  const response = await fetch(path, { headers: await getAuthHeaders() });
  if (!response.ok) {
    throw new Error(`${resourceName} request failed`);
  }
  const payload: unknown = await response.json();
  const result = z.object({ data: z.array(schema) }).safeParse(payload);
  if (!result.success) {
    throw new Error(`${resourceName} response was invalid`);
  }
  return result.data.data;
}

function isPendingCapture(capture: CaptureResource): boolean {
  return (
    capture.status === "uploading" ||
    capture.status === "queued" ||
    capture.status === "extracting" ||
    capture.status === "importing"
  );
}
