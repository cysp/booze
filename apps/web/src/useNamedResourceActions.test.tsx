import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MutationCompletion } from "./useCatalogue.ts";
import { useNamedResourceActions } from "./useNamedResourceActions.ts";

type NamedResourceKind = "location" | "site";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useNamedResourceActions", () => {
  it("keeps the renamed resource ID and value atomic", () => {
    const { result } = setup("location");

    act(() => {
      result.current.beginRename("location-1", "Cellar");
    });
    expect(result.current.editor).toEqual({ id: "location-1", name: "Cellar" });

    act(() => {
      result.current.setRename("Upstairs cellar");
    });
    expect(result.current.editor).toEqual({ id: "location-1", name: "Upstairs cellar" });

    act(() => {
      result.current.cancelRename();
    });
    expect(result.current.editor).toBeNull();
  });

  it.each([
    {
      id: "location-1",
      kind: "location" as const,
      name: "Upstairs cellar",
      path: "/api/storage-locations/location-1",
      pendingStatus: "Updating location...",
      successMessage: "Location updated.",
    },
    {
      id: "site-1",
      kind: "site" as const,
      name: "Home cellar",
      path: "/api/sites/site-1",
      pendingStatus: "Updating site...",
      successMessage: "Site updated.",
    },
  ])("renames a $kind and completes its catalogue mutation", async (example) => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const { completeMutation, result, setStatus } = setup(example.kind);

    act(() => {
      result.current.beginRename(example.id, "Original name");
      result.current.setRename(example.name);
    });

    let saved = false;
    await act(async () => {
      saved = await result.current.saveRename();
    });

    expect(saved).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(example.path, {
      body: JSON.stringify({ name: example.name }),
      headers: {
        authorization: "Bearer test",
        "content-type": "application/json",
      },
      method: "PATCH",
    });
    expect(setStatus).toHaveBeenCalledWith(example.pendingStatus);
    expect(completeMutation).toHaveBeenCalledOnce();
    expect(completeMutation).toHaveBeenCalledWith({
      refresh: "catalogue",
      successMessage: example.successMessage,
    });
    expect(result.current.editor).toBeNull();
  });

  it.each(["location", "site"] as const)(
    "encodes the full opaque %s ID for rename and delete",
    async (kind) => {
      const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
      vi.stubGlobal("fetch", fetchMock);
      const { result } = setup(kind);
      const id = "legacy # / ? % ID";
      act(() => {
        result.current.beginRename(id, "Renamed");
      });
      await act(async () => {
        await result.current.saveRename();
      });
      await act(async () => {
        await result.current.remove(id);
      });
      const collection = kind === "site" ? "sites" : "storage-locations";
      expect(fetchMock.mock.calls).toEqual([
        [
          `/api/${collection}/legacy%20%23%20%2F%20%3F%20%25%20ID`,
          expect.objectContaining({ method: "PATCH" }),
        ],
        [
          `/api/${collection}/legacy%20%23%20%2F%20%3F%20%25%20ID`,
          expect.objectContaining({ method: "DELETE" }),
        ],
      ]);
    },
  );

  it("retains the editor after validation and HTTP failures", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const { completeMutation, result, setStatus } = setup("location");

    act(() => {
      result.current.beginRename("location-1", " ");
    });
    let saved = true;
    await act(async () => {
      saved = await result.current.saveRename();
    });
    expect(saved).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(setStatus).toHaveBeenLastCalledWith("Enter a location name before saving.");
    expect(result.current.editor).toEqual({ id: "location-1", name: " " });

    act(() => {
      result.current.setRename("Cellar");
    });
    await act(async () => {
      saved = await result.current.saveRename();
    });
    expect(saved).toBe(false);
    expect(setStatus).toHaveBeenLastCalledWith("Location was not updated.");
    expect(completeMutation).not.toHaveBeenCalled();
    expect(result.current.editor).toEqual({ id: "location-1", name: "Cellar" });
  });

  it.each([
    {
      id: "location-1",
      kind: "location" as const,
      path: "/api/storage-locations/location-1",
      pendingStatus: "Deleting location...",
      successMessage: "Location deleted. Bottles stayed in the site without a location.",
    },
    {
      id: "site-1",
      kind: "site" as const,
      path: "/api/sites/site-1",
      pendingStatus: "Deleting site...",
      successMessage: "Site deleted.",
    },
  ])("deletes a $kind with its exact completion contract", async (example) => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const { completeMutation, result, setStatus } = setup(example.kind);

    let removed = false;
    await act(async () => {
      removed = await result.current.remove(example.id);
    });

    expect(removed).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(example.path, {
      headers: { authorization: "Bearer test" },
      method: "DELETE",
    });
    expect(setStatus).toHaveBeenCalledWith(example.pendingStatus);
    expect(completeMutation).toHaveBeenCalledWith({
      refresh: "catalogue",
      successMessage: example.successMessage,
    });
  });

  it("keeps a committed rename successful when completion reports a refresh issue", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    const setStatus = vi.fn<(status: string) => void>();
    const completeMutation = vi.fn(async ({ successMessage }: MutationCompletion) => {
      setStatus(`${successMessage} Latest data could not be refreshed.`);
    });
    const { result } = renderHook(() =>
      useNamedResourceActions({
        completeMutation,
        getAuthHeaders: async () => ({ authorization: "Bearer test" }),
        kind: "site",
        setStatus,
      }),
    );

    act(() => {
      result.current.beginRename("site-1", "Home cellar");
    });
    let saved = false;
    await act(async () => {
      saved = await result.current.saveRename();
    });

    expect(saved).toBe(true);
    expect(setStatus).toHaveBeenLastCalledWith("Site updated. Latest data could not be refreshed.");
    expect(result.current.editor).toBeNull();
  });

  it("leaves network failures for the UI operation handler", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    const { completeMutation, result } = setup("site");

    act(() => {
      result.current.beginRename("site-1", "Home cellar");
    });

    await act(async () => {
      await expect(result.current.saveRename()).rejects.toThrow("offline");
    });
    expect(completeMutation).not.toHaveBeenCalled();
    expect(result.current.editor).toEqual({ id: "site-1", name: "Home cellar" });
  });
});

function setup(kind: NamedResourceKind) {
  const completeMutation = vi.fn(
    async (_completion: MutationCompletion): Promise<void> => undefined,
  );
  const getAuthHeaders = vi.fn(async (): Promise<Record<string, string>> => ({
    authorization: "Bearer test",
  }));
  const setStatus = vi.fn<(status: string) => void>();
  const hook = renderHook(() =>
    useNamedResourceActions({
      completeMutation,
      getAuthHeaders,
      kind,
      setStatus,
    }),
  );
  return { ...hook, completeMutation, getAuthHeaders, setStatus };
}
