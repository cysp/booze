import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { useReadPage } from "./useReadPage.ts";
const schema = z.object({
  data: z.array(z.object({ id: z.string(), value: z.number() })),
  totalCount: z.number(),
  nextPageToken: z.string().nullable(),
});
const firstAuth = async () => ({ actor: "first" });
const secondAuth = async () => ({ actor: "second" });
const auth = async () => ({});
const page = (id: string, value = 1, nextPageToken: string | null = null) =>
  new Response(JSON.stringify({ data: [{ id, value }], totalCount: 100, nextPageToken }));
afterEach(() => {
  vi.unstubAllGlobals();
});
describe("bounded page reads", () => {
  it("does not fetch more pages until requested, appends by ID, and refreshes from the first page", async () => {
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        requests.push(input);
        return input.includes("pageToken=") ? page("second") : page("first", 1, "opaque/token");
      }),
    );
    const { result } = renderHook(() =>
      useReadPage({ active: true, getAuthHeaders: auth, path: "/api/items?query=one", schema }),
    );
    await waitFor(() => {
      expect(result.current.page?.data).toHaveLength(1);
    });
    expect(requests).toHaveLength(1);
    await act(async () => result.current.loadMore());
    expect(requests[1]).toBe("/api/items?query=one&pageToken=opaque%2Ftoken");
    expect(result.current.page?.data.map((row) => row.id)).toEqual(["first", "second"]);
    await act(async () => result.current.refresh());
    expect(result.current.page?.data.map((row) => row.id)).toEqual(["first"]);
  });
  it("ignores an old query response after filters change", async () => {
    let resolve: ((response: Response) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) =>
        input.includes("old")
          ? new Promise<Response>((done) => {
              resolve = done;
            })
          : page("new"),
      ),
    );
    const { result, rerender } = renderHook(
      ({ query }) =>
        useReadPage({
          active: true,
          getAuthHeaders: auth,
          path: `/api/items?query=${query}`,
          schema,
        }),
      { initialProps: { query: "old" } },
    );
    await waitFor(() => {
      expect(resolve).toBeDefined();
    });
    rerender({ query: "new" });
    await waitFor(() => {
      expect(result.current.page?.data[0]?.id).toBe("new");
    });
    await act(async () => {
      resolve?.(page("old"));
    });
    expect(result.current.page?.data[0]?.id).toBe("new");
  });
  it("ignores older refresh success after a newer read fails and keeps retryable stale data", async () => {
    let requests = 0;
    let resolve: ((response: Response) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        requests += 1;
        if (requests === 2)
          return new Promise<Response>((done) => {
            resolve = done;
          });
        return requests === 3 ? new Response(null, { status: 503 }) : page("initial");
      }),
    );
    const { result } = renderHook(() =>
      useReadPage({ active: true, getAuthHeaders: auth, path: "/api/items", schema }),
    );
    await waitFor(() => {
      expect(result.current.page).not.toBeNull();
    });
    let older = Promise.resolve<unknown>(null);
    await act(async () => {
      older = result.current.refresh();
    });
    await act(async () => {
      await expect(result.current.refresh()).rejects.toThrow();
    });
    await act(async () => {
      resolve?.(page("older"));
      await older;
    });
    expect(result.current.page?.data[0]?.id).toBe("initial");
    expect(result.current.error).not.toBeNull();
    await act(async () => result.current.refresh());
    expect(result.current.error).toBeNull();
  });
  it("cannot populate another actor with an old in-flight request or previous data", async () => {
    let resolve: ((response: Response) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string, options: { readonly headers: Record<string, string> }) =>
        options.headers["actor"] === "first"
          ? new Promise<Response>((done) => {
              resolve = done;
            })
          : page("second"),
      ),
    );
    const { result, rerender } = renderHook(
      ({ getAuthHeaders }) =>
        useReadPage({ active: true, getAuthHeaders, path: "/api/items", schema }),
      { initialProps: { getAuthHeaders: firstAuth } },
    );
    await waitFor(() => {
      expect(resolve).toBeDefined();
    });
    rerender({ getAuthHeaders: secondAuth });
    expect(result.current.page).toBeNull();
    await waitFor(() => {
      expect(result.current.page?.data[0]?.id).toBe("second");
    });
    await act(async () => {
      resolve?.(page("first"));
    });
    expect(result.current.page?.data[0]?.id).toBe("second");
  });
  it("keeps loaded rows when loading the next page fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) =>
        input.includes("pageToken")
          ? new Response(null, { status: 503 })
          : page("first", 1, "next"),
      ),
    );
    const { result } = renderHook(() =>
      useReadPage({ active: true, getAuthHeaders: auth, path: "/api/items", schema }),
    );
    await waitFor(() => {
      expect(result.current.page).not.toBeNull();
    });
    await act(async () => {
      await expect(result.current.loadMore()).rejects.toThrow();
    });
    expect(result.current.page?.data[0]?.id).toBe("first");
    expect(result.current.error).not.toBeNull();
  });
  it("an old refresh callback cannot fetch after its page becomes inactive", async () => {
    const fetch = vi.fn(async () => page("one"));
    vi.stubGlobal("fetch", fetch);
    const { result, rerender } = renderHook(
      ({ active }) => useReadPage({ active, getAuthHeaders: auth, path: "/api/items", schema }),
      { initialProps: { active: true } },
    );
    await waitFor(() => {
      expect(result.current.page).not.toBeNull();
    });
    const previousRefresh = result.current.refresh;
    rerender({ active: false });
    fetch.mockClear();
    await act(async () => {
      expect(await previousRefresh()).toBe("superseded");
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
