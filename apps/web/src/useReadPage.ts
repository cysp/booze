import { useCallback, useEffect, useRef, useState } from "react";
import type { z } from "zod";

export type AuthHeadersProvider = () => Promise<Record<string, string>>;
export type RefreshResult = "refreshed" | "superseded";
type ReadPage = {
  readonly data: readonly { readonly id?: string; readonly wineVintageId?: string }[];
  readonly totalCount: number;
  readonly nextPageToken: string | null;
};

export type ReadPageController<Page> = {
  readonly page: Page | null;
  readonly error: string | null;
  readonly isLoading: boolean;
  readonly isRefreshing: boolean;
  readonly refresh: () => Promise<RefreshResult>;
  readonly loadMore: () => Promise<RefreshResult>;
};

/** Owns one bounded query. A refresh replaces its pages; only explicit loadMore appends. */
export function useReadPage<Page extends ReadPage>({
  active,
  getAuthHeaders,
  path,
  schema,
}: {
  readonly active: boolean;
  readonly getAuthHeaders: AuthHeadersProvider;
  readonly path: string;
  readonly schema: z.ZodType<Page> | (() => Promise<z.ZodType<Page>>);
}): ReadPageController<Page> {
  const [loaded, setLoaded] = useState<{
    readonly path: string;
    readonly getAuthHeaders: AuthHeadersProvider;
    readonly page: Page;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const requestVersion = useRef(0);
  const currentRequest = useRef({ active, getAuthHeaders, path });
  currentRequest.current = { active, getAuthHeaders, path };
  const page =
    loaded?.path === path && loaded.getAuthHeaders === getAuthHeaders ? loaded.page : null;
  const pageRef = useRef(page);
  pageRef.current = page;

  const request = useCallback(
    async (append: boolean): Promise<RefreshResult> => {
      if (
        !active ||
        !currentRequest.current.active ||
        currentRequest.current.path !== path ||
        currentRequest.current.getAuthHeaders !== getAuthHeaders
      )
        return "superseded";
      const previous = pageRef.current;
      if (append && previous?.nextPageToken === null) return "refreshed";
      requestVersion.current += 1;
      const version = requestVersion.current;
      setPending(true);
      const parameters = new URL(path, window.location.origin);
      if (append && previous !== null && previous.nextPageToken !== null)
        parameters.searchParams.set("pageToken", previous.nextPageToken);
      const isCurrent = () =>
        version === requestVersion.current &&
        currentRequest.current.active &&
        currentRequest.current.path === path &&
        currentRequest.current.getAuthHeaders === getAuthHeaders;
      try {
        const response = await fetch(`${parameters.pathname}${parameters.search}`, {
          headers: await getAuthHeaders(),
        });
        if (!response.ok) throw new Error("Read failed");
        const parser = typeof schema === "function" ? await schema() : schema;
        const next = parser.parse(await response.json());
        if (!isCurrent()) return "superseded";
        const result =
          append && previous !== null
            ? { ...next, data: mergeRows(previous.data, next.data) }
            : next;
        setLoaded({ path, getAuthHeaders, page: result });
        setError(null);
        return "refreshed";
      } catch (cause) {
        if (!isCurrent()) return "superseded";
        setError("Latest data could not be refreshed. Try again.");
        throw cause;
      } finally {
        if (isCurrent()) setPending(false);
      }
    },
    [active, getAuthHeaders, path, schema],
  );
  const refresh = useCallback(async () => request(false), [request]);
  const loadMore = useCallback(async () => request(true), [request]);
  useEffect(() => {
    if (active)
      void (async () => {
        try {
          await refresh();
        } catch {
          /* The read retains its error and previous page. */
        }
      })();
    else setPending(false);
    return () => {
      requestVersion.current += 1;
    };
  }, [active, refresh]);
  return {
    page,
    error,
    isLoading: active && page === null && pending,
    isRefreshing: pending,
    refresh,
    loadMore,
  };
}

function mergeRows<Row extends { readonly id?: string; readonly wineVintageId?: string }>(
  previous: readonly Row[],
  next: readonly Row[],
): Row[] {
  const rows = new Map(previous.map((row) => [row.id ?? row.wineVintageId, row]));
  for (const row of next) rows.set(row.id ?? row.wineVintageId, row);
  return [...rows.values()];
}
