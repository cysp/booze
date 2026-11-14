import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { problemResponse } from "../worker/api/http.ts";
import { sitesFixture } from "./test/catalogue-fixtures.ts";
import { useCaptureController } from "./useCatalogueControllers.ts";

afterEach(() => vi.unstubAllGlobals());

it("shows the API's actionable problem detail when a capture cannot be imported", async () => {
  const message =
    "Capture processing changed before import. Refresh the capture before trying again.";
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      problemResponse({
        status: 400,
        title: "Request failed",
        detail: message,
      }),
    ),
  );
  const setStatus = vi.fn<(status: string) => void>();
  const completeMutation = vi.fn(async (): Promise<void> => {
    await Promise.resolve();
  });
  const { result } = renderHook(() =>
    useCaptureController({
      completeMutation,
      getAuthHeaders: async () => ({}),
      setStatus,
      writableSites: sitesFixture,
    }),
  );
  await act(async () => {
    await result.current.importCapture("capture");
  });
  expect(setStatus).toHaveBeenLastCalledWith(`Import failed: ${message}`);
  expect(completeMutation).not.toHaveBeenCalled();
});

it("persists the review snapshot with its revision and returns the confirmed server revision", async () => {
  const candidate = {
    wine: { wineryName: "RIKARD", designation: "", grapeVarieties: ["Shiraz"] },
    bottle: {},
  };
  const fetchMock = vi.fn(async () =>
    Response.json({ data: { reviewCandidate: candidate, reviewRevision: 3 } }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const completeMutation = vi.fn(async (): Promise<void> => {
    await Promise.resolve();
  });
  const { result } = renderHook(() =>
    useCaptureController({
      completeMutation,
      getAuthHeaders: async () => ({}),
      setStatus: vi.fn<(status: string) => void>(),
      writableSites: sitesFixture,
    }),
  );
  await act(async () => {
    expect(await result.current.saveCaptureReview("capture # / ? % ID", 2, candidate)).toEqual({
      ok: true,
      reviewCandidate: candidate,
      reviewRevision: 3,
    });
  });
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/bottle-captures/capture%20%23%20%2F%20%3F%20%25%20ID/review",
    expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ expectedRevision: 2, candidate }),
    }),
  );
  expect(completeMutation).toHaveBeenCalledWith(expect.objectContaining({ refresh: "captures" }));
});
