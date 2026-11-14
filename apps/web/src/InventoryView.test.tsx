import axe from "axe-core";
import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { InventorySummaryItem } from "./inventory-model.ts";
import { InventoryArea } from "./InventoryView.tsx";
import {
  inventoryFixtures,
  inventoryItemFixture,
  locationsFixture,
} from "./test/catalogue-fixtures.ts";

const noop = (): void => {
  // Intentionally records no state; each test asserts the rendered permission surface.
};

function renderInventory(
  editableSiteIds: ReadonlySet<string>,
  items = inventoryFixtures.many as readonly ReturnType<typeof inventoryItemFixture>[],
  onEditBottle = noop as (item: InventorySummaryItem) => void,
  onCreateSite?: () => void,
  grouping: "winery" | "storage" = "winery",
) {
  return render(
    <InventoryArea
      drinkStatusFilter=""
      drinkStatusOptions={[
        { label: "Drink now", value: "drink-now" },
        { label: "Hold", value: "hold" },
      ]}
      editableSiteIds={editableSiteIds}
      filter=""
      grouping={grouping}
      items={items}
      siteIdFilter=""
      siteOptions={[]}
      setSiteIdFilter={noop}
      storageLocationIdFilter=""
      locationOptions={[{ label: "Home cellar / Left rack", value: "location-left" }]}
      locations={locationsFixture}
      varietalFilter=""
      varietalOptions={["Shiraz"]}
      onCreateSite={onCreateSite}
      onAddBottle={noop}
      onEditBottle={onEditBottle}
      setDrinkStatusFilter={noop}
      setFilter={noop}
      setGrouping={noop}
      setStorageLocationIdFilter={noop}
      setVarietalFilter={noop}
    />,
  );
}

describe("InventoryArea", () => {
  it("gives an empty cellar a direct first-site setup action", async () => {
    const user = userEvent.setup();
    const onCreateSite = vi.fn<() => void>();
    renderInventory(new Set(), [], noop, onCreateSite);
    await user.click(screen.getByRole("button", { name: "Create your first site" }));
    expect(onCreateSite).toHaveBeenCalledTimes(1);
  });

  it("lets the user choose the exact physical bottle within a shared wine", async () => {
    const user = userEvent.setup();
    const first = inventoryItemFixture({
      id: "bottle-1",
      positionHint: "Slot 1",
      bottleNotes: "Pristine",
    });
    const second = inventoryItemFixture({
      id: "bottle-2",
      positionHint: "Slot 2",
      lotCode: "L42",
      bottleNotes: "Damaged label",
    });
    const onEditBottle = vi.fn<(item: InventorySummaryItem) => void>();
    renderInventory(new Set(["site-owner"]), [first, second], onEditBottle);

    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    await user.click(screen.getByText("Choose a bottle to edit, move, or mark drunk"));
    const bottleRow = screen.getByText("Bottle 2 · Home cellar / Left rack / Slot 2").closest("li");
    expect(bottleRow).not.toBeNull();
    expect(bottleRow).toHaveTextContent("750ml");
    if (bottleRow === null) {
      throw new Error("Missing bottle row");
    }
    await user.click(within(bottleRow).getByRole("button", { name: "Edit bottle 2" }));

    expect(onEditBottle).toHaveBeenCalledExactlyOnceWith(second);
  });

  it("keeps same-name sites and locations in separate storage groups", () => {
    const items = [
      inventoryItemFixture({
        id: "first",
        siteId: "site-a",
        siteName: "Cellar",
        storageLocationId: "rack-a",
        storageLocationName: "Rack",
      }),
      inventoryItemFixture({
        id: "second",
        siteId: "site-b",
        siteName: "Cellar",
        storageLocationId: "rack-b",
        storageLocationName: "Rack",
      }),
      inventoryItemFixture({
        id: "third",
        siteId: "site-a",
        siteName: "Cellar",
        storageLocationId: "rack-c",
        storageLocationName: "Rack",
      }),
    ];
    const { container } = renderInventory(
      new Set(["site-a", "site-b"]),
      items,
      noop,
      undefined,
      "storage",
    );
    expect(container.querySelectorAll(".inventory-group")).toHaveLength(2);
    expect(container.querySelectorAll(".nested-group")).toHaveLength(3);
    expect(screen.getByRole("heading", { name: "Cellar (site-a)" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Cellar (site-b)" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Rack (rack-a)" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Rack (rack-c)" })).toBeVisible();
    expect(screen.getAllByRole("button", { name: "Edit" })).toHaveLength(3);
  });

  it("keeps an opaque winery ID separate from a missing winery key", () => {
    const items = [
      inventoryItemFixture({
        id: "known",
        wineryId: "unknown:site-owner",
        wineryName: "Known producer",
      }),
      inventoryItemFixture({
        id: "unknown",
        wineryId: null,
        wineryName: "",
        wineVintageId: "unknown-wine",
      }),
    ];
    const { container } = renderInventory(new Set(["site-owner"]), items);
    expect(container.querySelectorAll(".inventory-group")).toHaveLength(2);
    expect(screen.getByRole("heading", { name: "Known producer" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Unknown winery" })).toBeVisible();
  });

  it("does not expose write actions for read-only sites", () => {
    renderInventory(new Set());

    expect(screen.queryByRole("button", { name: "Add bottle" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
  });

  it("renders populated long-content fixtures without automated accessibility violations", async () => {
    const { container } = renderInventory(new Set(["site-owner"]));

    const result = await axe.run(container, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(result.violations).toEqual([]);
  });
});
