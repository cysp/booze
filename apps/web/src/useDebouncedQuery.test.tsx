import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { useDebouncedQuery } from "./useDebouncedQuery.ts";
import { useReadPage } from "./useReadPage.ts";
const auth = async () => ({});
const schema = z.object({
  data: z.array(z.object({ id: z.string() })),
  totalCount: z.number(),
  nextPageToken: z.string().nullable(),
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("keeps rapid typing local and requests only the settled server query", async () => {
  vi.useFakeTimers();
  const fetch = vi.fn(async () => Response.json({ data: [], totalCount: 0, nextPageToken: null }));
  vi.stubGlobal("fetch", fetch);
  const { rerender } = renderHook(
    ({ input }) => {
      const query = useDebouncedQuery(input);
      return useReadPage({
        active: true,
        getAuthHeaders: auth,
        path: `/api/items?query=${query}`,
        schema,
      });
    },
    { initialProps: { input: "" } },
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  fetch.mockClear();
  rerender({ input: "S" });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(75);
  });
  rerender({ input: "Shi" });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(75);
  });
  rerender({ input: "Shiraz" });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(199);
  });
  expect(fetch).not.toHaveBeenCalled();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/items?query=Shiraz", expect.any(Object));
});
