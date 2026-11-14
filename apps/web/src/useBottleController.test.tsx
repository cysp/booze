import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inventoryItemFixture, sitesFixture } from "./test/catalogue-fixtures.ts";
import { useBottleController } from "./useCatalogueControllers.ts";

function context() {
  return {
    completeMutation: vi.fn(async (): Promise<void> => {
      await Promise.resolve();
    }),
    getAuthHeaders: async () => ({}),
    locations: [],
    setStatus: vi.fn<(status: string) => void>(),
    writableSites: sitesFixture,
  };
}
function deferred<T>() {
  return Promise.withResolvers<T>();
}

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe("direct bottle detail and explicit mutations", () => {
  it("fetches one physical bottle directly without loading an inventory page and closes without mutation", async () => {
    const item = inventoryItemFixture({ id: "physical / bottle" });
    const fetch = vi.fn(async () => Response.json({ data: item }));
    vi.stubGlobal("fetch", fetch);
    const shared = context();
    const { result } = renderHook(() => useBottleController(shared));
    await act(async () => {
      await result.current.openBottleDetails({ id: item.id });
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]).toEqual(["/api/bottles/physical%20%2F%20bottle", { headers: {} }]);
    expect(result.current.selectedBottle?.id).toBe(item.id);
    act(() => {
      result.current.closeBottleDetails();
    });
    expect(result.current.selectedBottle).toBeNull();
    expect(shared.completeMutation).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("ignores a detail result after deliberate close", async () => {
    const detail = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => detail.promise),
    );
    const shared = context();
    const { result } = renderHook(() => useBottleController(shared));
    let opening: Promise<void> | undefined;
    act(() => {
      opening = result.current.openBottleDetails({ id: "bottle-1" });
    });
    act(() => {
      result.current.closeBottleDetails();
    });
    detail.resolve(Response.json({ data: inventoryItemFixture() }));
    await act(async () => {
      await opening;
    });
    expect(result.current.selectedBottle).toBeNull();
  });
  it("rereads direct details after a confirmed edit and catalogue refresh", async () => {
    const original = inventoryItemFixture();
    const saved = inventoryItemFixture({ bottleNotes: "Saved note" });
    let gets = 0;
    const requests: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        requests.push(init);
        if (init.method === "PATCH") return Response.json({ data: { id: original.id } });
        gets += 1;
        return Response.json({ data: gets === 1 ? original : saved });
      }),
    );
    const shared = context();
    const { result } = renderHook(() => useBottleController(shared));
    await act(async () => {
      await result.current.openBottleDetails(original);
    });
    await act(async () => {
      expect(
        await result.current.saveBottleEdit({
          kind: "edit-bottle",
          bottle: { notes: "Saved note" },
        }),
      ).toEqual({ ok: true });
    });
    expect(result.current.selectedBottle?.bottleNotes).toBe("Saved note");
    expect(requests.filter((request) => request.method === "PATCH")).toHaveLength(1);
    expect(requests.find((request) => request.method === "PATCH")?.body).toBe(
      JSON.stringify({ bottle: { notes: "Saved note" } }),
    );
    expect(shared.completeMutation).toHaveBeenCalledWith({
      refresh: "catalogue",
      successMessage: "Inventory updated.",
    });
  });
  it("closes unavailable details after a confirmed status update without reporting or repeating a failed mutation", async () => {
    let gets = 0;
    let patches = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        if (init.method === "PATCH") {
          patches += 1;
          return Response.json({ data: { id: "bottle-1" } });
        }
        gets += 1;
        if (gets > 1) throw new Error("read failed after commit");
        return Response.json({ data: inventoryItemFixture() });
      }),
    );
    const shared = context();
    const { result } = renderHook(() => useBottleController(shared));
    await act(async () => {
      await result.current.openBottleDetails({ id: "bottle-1" });
    });
    await act(async () => {
      expect(
        await result.current.updateBottle({
          bottleId: "bottle-1",
          payload: { status: "consumed" },
        }),
      ).toBe(true);
    });
    expect(result.current.selectedBottle).toBeNull();
    expect(shared.setStatus).toHaveBeenLastCalledWith(
      "Bottle updated. Details could not be reloaded; open the bottle again to view its current facts.",
    );
    expect(patches).toBe(1);
  });
  it("refreshes the catalogue after confirmed deletion", async () => {
    const methods: (string | undefined)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        methods.push(init.method);
        return init.method === "DELETE"
          ? new Response(null, { status: 204 })
          : Response.json({ data: inventoryItemFixture() });
      }),
    );
    const shared = context();
    const { result } = renderHook(() => useBottleController(shared));
    await act(async () => {
      await result.current.openBottleDetails({ id: "bottle-1" });
    });
    await act(async () => {
      expect(await result.current.deleteBottle("bottle-1")).toBe(true);
    });
    act(() => {
      result.current.closeBottleDetails();
    });
    expect(result.current.selectedBottle).toBeNull();
    expect(methods.filter((method) => method === "DELETE")).toHaveLength(1);
    expect(shared.completeMutation).toHaveBeenCalledWith({
      refresh: "catalogue",
      successMessage: "Bottle deleted.",
    });
  });
  it("does not let an old failed detail refresh close the same bottle reopened by a new actor", async () => {
    const oldRead = deferred<Response>();
    let gets = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        if (init.method === "PATCH") return Response.json({ data: { id: "bottle-1" } });
        gets += 1;
        if (gets === 2) return oldRead.promise;
        return Response.json({
          data: inventoryItemFixture({ bottleNotes: gets > 2 ? "New actor detail" : null }),
        });
      }),
    );
    const shared = context();
    const { result, rerender } = renderHook(
      ({ additionScope }) => useBottleController({ ...shared, additionScope }),
      { initialProps: { additionScope: "actor-one" } },
    );
    await act(async () => {
      await result.current.openBottleDetails({ id: "bottle-1" });
    });
    let saving: Promise<unknown> | undefined;
    act(() => {
      saving = result.current.saveBottleEdit({
        kind: "edit-bottle",
        bottle: { notes: "Old actor mutation" },
      });
    });
    await waitFor(() => {
      expect(gets).toBe(2);
    });
    rerender({ additionScope: "actor-two" });
    await act(async () => {
      await result.current.openBottleDetails({ id: "bottle-1" });
    });
    expect(result.current.selectedBottle?.bottleNotes).toBe("New actor detail");
    const statusAfterNewActorRead = shared.setStatus.mock.lastCall;
    oldRead.reject(new Error("old actor refresh failed"));
    await act(async () => {
      await saving;
    });
    expect(result.current.selectedBottle?.bottleNotes).toBe("New actor detail");
    expect(shared.setStatus.mock.lastCall).toEqual(statusAfterNewActorRead);
  });
  it("does not issue a PATCH for an unchanged focused action", async () => {
    const fetch = vi.fn(async () => Response.json({ data: inventoryItemFixture() }));
    vi.stubGlobal("fetch", fetch);
    const shared = context();
    const { result } = renderHook(() => useBottleController(shared));
    await act(async () => {
      await result.current.openBottleDetails({ id: "bottle-1" });
    });
    await act(async () => {
      expect(await result.current.saveBottleEdit({ kind: "edit-bottle", bottle: {} })).toEqual({
        ok: true,
      });
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(shared.completeMutation).not.toHaveBeenCalled();
  });
});
