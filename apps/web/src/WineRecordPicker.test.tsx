import { useState, type ReactElement } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { bottles } from "../e2e/catalogue-fixtures.ts";
import { WineRecordPicker } from "./WineRecordPicker.tsx";
const auth = async () => ({});
const option = { ...bottles[0], wineVintageId: "depleted-wine" };
afterEach(() => vi.unstubAllGlobals());

it("reads bounded site/query choices including zero-stock wines and loads further choices only on request", async () => {
  const user = userEvent.setup();
  const requests: URL[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const url = new URL(input, window.location.origin);
      requests.push(url);
      return Response.json({
        data: [option],
        totalCount: 75,
        nextPageToken: url.searchParams.has("pageToken") ? null : "next/page",
      });
    }),
  );
  render(
    <WineRecordPicker
      label="Wine record"
      siteId="site-owner"
      selected=""
      onChange={vi.fn<() => void>()}
      getAuthHeaders={auth}
    />,
  );
  await waitFor(() => {
    expect(requests).toHaveLength(1);
  });
  expect(requests[0]?.searchParams.get("siteId")).toBe("site-owner");
  expect(requests[0]?.searchParams.get("limit")).toBe("50");
  await user.click(screen.getByRole("combobox", { name: "Wine record" }));
  expect(screen.getByRole("option", { name: /depleted-wine/u })).toBeVisible();
  await user.keyboard("{Escape}");
  await user.click(screen.getByRole("button", { name: "Load more wine records" }));
  await waitFor(() => {
    expect(requests).toHaveLength(2);
  });
  expect(requests[1]?.searchParams.get("pageToken")).toBe("next/page");
  await user.type(screen.getByRole("textbox", { name: "Search wine records" }), "%_");
  await waitFor(() => {
    expect(requests.at(-1)?.searchParams.get("query")).toBe("%_");
  });
  expect(requests.at(-1)?.searchParams.has("pageToken")).toBe(false);
});

it("resolves an initially selected wine outside the first page through its exact opaque ID", async () => {
  const requests: string[] = [];
  const id = "old / ? wine";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      requests.push(input);
      return input.startsWith("/api/wines/")
        ? Response.json({ data: { ...bottles[0], id, bottleCount: 0, inStockBottleCount: 0 } })
        : Response.json({ data: [], totalCount: 0, nextPageToken: null });
    }),
  );
  render(
    <WineRecordPicker
      label="Wine record"
      siteId="site-owner"
      selected={id}
      onChange={vi.fn<() => void>()}
      getAuthHeaders={auth}
    />,
  );
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Wine record" })).toHaveTextContent(
      "2023 Pinnacle Series Shiraz",
    ),
  );
  expect(requests).toContain("/api/wines/old%20%2F%20%3F%20wine");
  expect(requests.filter((request) => request.includes("pageToken"))).toEqual([]);
});

function SelectionHarness(): ReactElement {
  const [selected, setSelected] = useState("private-wine");
  return (
    <WineRecordPicker
      label="Wine record"
      siteId="site-owner"
      selected={selected}
      onChange={setSelected}
      getAuthHeaders={auth}
    />
  );
}

it("rejects wrong-site selected details and clears that warning after a valid choice", async () => {
  const user = userEvent.setup();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) =>
      input.startsWith("/api/wines/")
        ? Response.json({
            data: {
              ...bottles[0],
              id: "private-wine",
              siteId: "other-site",
              bottleCount: 0,
              inStockBottleCount: 0,
            },
          })
        : Response.json({ data: [option], totalCount: 1, nextPageToken: null }),
    ),
  );
  render(<SelectionHarness />);
  expect(await screen.findByText("Selected wine could not be loaded.")).toBeVisible();
  await user.click(screen.getByRole("combobox", { name: "Wine record" }));
  await user.click(screen.getByRole("option", { name: /depleted-wine/u }));
  expect(screen.queryByText("Selected wine could not be loaded.")).not.toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "Wine record" })).toHaveTextContent(
    "2023 Pinnacle Series Shiraz",
  );
});
