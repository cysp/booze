import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { initialCaptureFormState, initialFormState } from "./inventory-model.ts";
import { sitesFixture } from "./test/catalogue-fixtures.ts";
import { useBottleController, useCaptureController } from "./useCatalogueControllers.ts";

const form = { ...initialFormState, siteId: "site", wineryName: "Estate", quantity: "2" };
const submission = { kind: "add" as const, form, awards: [], criticReviews: [] };
afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});
function context() {
  return {
    completeMutation: vi.fn(async (): Promise<void> => {
      await Promise.resolve();
    }),
    getAuthHeaders: async () => ({}),
    setStatus: vi.fn<(status: string) => void>(),
    writableSites: sitesFixture,
  };
}
it("retains an uncertain bottle operation across retries and remount, blocks edited retry and rotates on confirmed success", async () => {
  const requests: Record<string, unknown>[] = [];
  let succeed = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      if (typeof init.body !== "string") throw new Error("Expected JSON request body");
      const payload: unknown = JSON.parse(init.body);
      if (typeof payload !== "object" || payload === null)
        throw new Error("Expected addition payload");
      requests.push({ ...payload });
      if (!succeed) throw new Error("response lost after commit");
      return Response.json({ data: { bottleIds: ["bottle"] } }, { status: 201 });
    }),
  );
  const shared = context();
  let hook = renderHook(() => useBottleController({ ...shared, locations: [] }));
  await act(async () => {
    expect((await hook.result.current.saveBottle(submission)).ok).toBe(false);
  });
  expect(shared.setStatus).toHaveBeenLastCalledWith(
    expect.stringContaining("could not be confirmed"),
  );
  expect(requests[0]?.["operationId"]).toEqual(expect.any(String));
  hook.unmount();
  hook = renderHook(() => useBottleController({ ...shared, locations: [] }));
  await act(async () => {
    await hook.result.current.saveBottle(submission);
  });
  expect(requests[1]?.["operationId"]).toBe(requests[0]?.["operationId"]);
  await act(async () => {
    await hook.result.current.saveBottle({ ...submission, form: { ...form, quantity: "3" } });
  });
  expect(requests).toHaveLength(2);
  expect(shared.setStatus).toHaveBeenLastCalledWith(
    expect.stringContaining("earlier addition is still unconfirmed"),
  );
  await act(async () => {
    await hook.result.current.saveBottle(submission);
  });
  expect(requests[2]?.["operationId"]).toBe(requests[0]?.["operationId"]);
  succeed = true;
  await act(async () => {
    expect((await hook.result.current.saveBottle(submission)).ok).toBe(true);
  });
  await act(async () => {
    expect((await hook.result.current.saveBottle(submission)).ok).toBe(true);
  });
  expect(requests[4]?.["operationId"]).not.toBe(requests[3]?.["operationId"]);
});
it("retains uncertain photos and operation identity, and resets the form after confirmed submission", async () => {
  const bodies: FormData[] = [];
  let succeed = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      if (!(init.body instanceof FormData)) throw new Error("Expected capture form data");
      bodies.push(init.body);
      if (!succeed) throw new Error("response lost");
      return Response.json(
        { data: { captureId: "capture", workflowInstanceId: "capture", intakeComplete: true } },
        { status: 201 },
      );
    }),
  );
  const shared = context();
  let hook = renderHook(() => useCaptureController(shared));
  const captureForm = { ...initialCaptureFormState, siteId: "site", quantity: "2" };
  const photo = new File(["photo"], "label.jpg", { type: "image/jpeg" });
  await act(async () => {
    expect((await hook.result.current.submitCapture(captureForm, [photo])).kind).toBe("failed");
  });
  expect(shared.setStatus).toHaveBeenLastCalledWith(
    expect.stringContaining("could not be confirmed"),
  );
  hook.unmount();
  hook = renderHook(() => useCaptureController(shared));
  const reselected = new File(["photo"], "label.jpg", { type: "image/jpeg" });
  await act(async () => {
    await hook.result.current.submitCapture(captureForm, [reselected]);
  });
  expect(bodies[0]?.get("operationId")).toEqual(expect.any(String));
  expect(bodies[1]?.get("operationId")).toBe(bodies[0]?.get("operationId"));
  const retainedImage = bodies[1]?.get("images");
  if (!(retainedImage instanceof File)) throw new Error("Expected retained photo");
  expect(retainedImage.name).toBe("label.jpg");
  succeed = true;
  await act(async () => {
    expect((await hook.result.current.submitCapture(captureForm, [photo])).kind).toBe("submitted");
  });
  expect(hook.result.current.captureForm.quantity).toBe("1");
});

it("clears bottle identity on deliberate cancellation and scopes pending operations to the signed-in user", async () => {
  const requests: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      if (typeof init.body !== "string") throw new Error("Expected JSON");
      const body: unknown = JSON.parse(init.body);
      if (typeof body !== "object" || body === null) throw new Error("Expected payload");
      requests.push({ ...body });
      throw new Error("response lost");
    }),
  );
  const shared = context();
  let hook = renderHook(
    ({ additionScope }) => useBottleController({ ...shared, additionScope, locations: [] }),
    { initialProps: { additionScope: "user-one" } },
  );
  await act(async () => {
    await hook.result.current.saveBottle(submission);
  });
  hook.unmount();
  hook = renderHook(
    ({ additionScope }) => useBottleController({ ...shared, additionScope, locations: [] }),
    { initialProps: { additionScope: "user-one" } },
  );
  await act(async () => {
    hook.result.current.cancelAddition("site");
  });
  await act(async () => {
    await hook.result.current.saveBottle(submission);
  });
  expect(requests[1]?.["operationId"]).not.toBe(requests[0]?.["operationId"]);
  hook.rerender({ additionScope: "user-two" });
  await act(async () => {
    await hook.result.current.saveBottle(submission);
  });
  expect(requests[2]?.["operationId"]).not.toBe(requests[1]?.["operationId"]);
  hook.rerender({ additionScope: "user-one" });
  await act(async () => {
    await hook.result.current.saveBottle(submission);
  });
  expect(requests[3]?.["operationId"]).toBe(requests[1]?.["operationId"]);
  await act(async () => {
    await hook.result.current.saveBottle({
      ...submission,
      form: { ...form, siteId: "other-site" },
    });
  });
  await act(async () => {
    await hook.result.current.saveBottle(submission);
  });
  expect(requests[5]?.["operationId"]).toBe(requests[1]?.["operationId"]);
  const stored = sessionStorage.getItem("booze:addition:v1:bottles:user-one:site") ?? "";
  expect(stored).not.toContain("Estate");
  const persisted: unknown = JSON.parse(stored);
  if (typeof persisted !== "object" || persisted === null)
    throw new Error("Expected pending identity");
  expect(Object.keys(persisted)).toEqual(["fingerprint", "operationId"]);
});

it("keeps photos and identity for incomplete or unreadable saved capture responses until intake is confirmed", async () => {
  const bodies: FormData[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      if (!(init.body instanceof FormData)) throw new Error("Expected photo request");
      bodies.push(init.body);
      if (bodies.length === 1)
        return Response.json(
          { data: { captureId: "capture", intakeComplete: false } },
          { status: 201 },
        );
      if (bodies.length === 2)
        return new Response("{", { status: 201, headers: { "content-type": "application/json" } });
      return Response.json(
        { data: { captureId: "capture", intakeComplete: true } },
        { status: 201 },
      );
    }),
  );
  const shared = context();
  const hook = renderHook(() => useCaptureController(shared));
  const captureForm = { ...initialCaptureFormState, siteId: "site", quantity: "2" };
  const files = [new File(["photo"], "label.jpg", { type: "image/jpeg" })];
  await act(async () => {
    hook.result.current.setCaptureForm(captureForm);
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await act(async () => {
      expect((await hook.result.current.submitCapture(captureForm, files)).kind).toBe("pending");
    });
    expect(hook.result.current.captureForm.quantity).toBe("2");
  }
  await act(async () => {
    expect(
      (await hook.result.current.submitCapture({ ...captureForm, position: "Changed" }, files))
        .kind,
    ).toBe("failed");
  });
  expect(bodies).toHaveLength(2);
  await act(async () => {
    expect((await hook.result.current.submitCapture(captureForm, files)).kind).toBe("submitted");
  });
  expect(bodies.map((body) => body.get("operationId"))).toEqual(
    Array.from({ length: 3 }, () => bodies[0]?.get("operationId")),
  );
  expect(hook.result.current.captureForm.quantity).toBe("1");
});
