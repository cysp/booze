import type { Page } from "@playwright/test";
import { z } from "zod";

import { expect, nativeRows, test } from "./local-worker-fixtures.ts";

const additionSchema = z.object({
  data: z.object({ bottleIds: z.array(z.string()), wineVintageId: z.string() }),
});
const operationSchema = z.object({ operationId: z.string() });

async function fillAddition(page: Page, siteName: string, quantity: number): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { exact: true, name: "Add bottle" }).click();
  const dialog = page.getByRole("dialog", { exact: true, name: "Add bottle" });
  await dialog.getByRole("combobox", { name: "Bottle location" }).click();
  await page.getByRole("option", { exact: true, name: `${siteName} / First rack` }).click();
  await dialog.getByRole("textbox", { exact: true, name: "Winery" }).fill("Browser Winery");
  await dialog
    .getByRole("textbox", { exact: true, name: "Designation (optional)" })
    .fill("Native integration Shiraz");
  await dialog.locator("input[name='quantity']").fill(String(quantity));
  await dialog.getByRole("textbox", { name: "Position note" }).fill("Initial row");
  await dialog.getByRole("textbox", { name: "Bottle notes" }).fill("Bought for the native flow");
}

function bottleRows(siteId: string) {
  return nativeRows(
    `SELECT b.id, b.wine_vintage_id, b.status, l.storage_location_id, l.position_hint
     FROM bottles b LEFT JOIN bottle_locations l ON l.bottle_id = b.id
     WHERE b.site_id = ? ORDER BY b.id`,
    siteId,
  );
}

test("persists physical bottle additions, moves, consumed history and restore through the local Worker", async ({
  page,
  localCatalogue,
}, testInfo) => {
  const { firstLocationId, secondLocationId, siteId, siteName } = localCatalogue;
  await fillAddition(page, siteName, 3);
  const addedResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/bottles" && response.request().method() === "POST",
  );
  await page.getByRole("button", { exact: true, name: "Save bottle" }).click();
  const response = await addedResponse;
  expect(response.status()).toBe(201);
  const { bottleIds, wineVintageId } = additionSchema.parse(await response.json()).data;
  expect(new Set(bottleIds).size).toBe(3);
  const originalRows = bottleRows(siteId);
  expect(originalRows).toEqual(
    bottleIds.toSorted().map((id) => ({
      id,
      position_hint: "Initial row",
      status: "in_stock",
      storage_location_id: firstLocationId,
      wine_vintage_id: wineVintageId,
    })),
  );

  await page.reload();
  await expect(page.getByText("3 bottles shown", { exact: true }).last()).toBeVisible();
  await page.getByText("Choose a bottle to view details", { exact: true }).click();
  const targetId = bottleIds[0] ?? "";
  await page
    .getByRole("listitem")
    .filter({ hasText: `Bottle ID: ${targetId}` })
    .getByRole("button", { name: /^View details for bottle /u })
    .click();
  let detail = page.getByRole("dialog", { exact: true, name: "Bottle details" });
  await expect(detail.getByText("Bought for the native flow", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("desktop-bottle-details.png") });
  await detail.getByRole("button", { exact: true, name: "Move" }).click();
  const move = page.getByRole("dialog", { exact: true, name: "Move bottle" });
  await move.getByRole("combobox", { name: "Bottle location" }).click();
  await page.getByRole("option", { exact: true, name: `${siteName} / Second shelf` }).click();
  await move.getByRole("textbox", { name: "Position note" }).fill("Target slot");
  await move.getByRole("button", { exact: true, name: "Move bottle" }).click();
  detail = page.getByRole("dialog", { exact: true, name: "Bottle details" });
  await expect(detail.getByText("Target slot", { exact: true })).toBeVisible();
  expect(bottleRows(siteId)).toEqual(
    originalRows.map((row) =>
      row["id"] === targetId
        ? { ...row, position_hint: "Target slot", storage_location_id: secondLocationId }
        : row,
    ),
  );

  await detail.getByRole("button", { exact: true, name: "Mark consumed" }).click();
  await page
    .getByRole("dialog", { exact: true, name: "Mark consumed" })
    .getByRole("button", { exact: true, name: "Mark consumed" })
    .click();
  await expect(detail.getByText("Consumed", { exact: true })).toBeVisible();
  await detail.getByRole("button", { exact: true, name: "Close" }).click();
  expect(bottleRows(siteId).filter((row) => row["status"] === "consumed")).toEqual([
    {
      id: targetId,
      position_hint: "Target slot",
      status: "consumed",
      storage_location_id: secondLocationId,
      wine_vintage_id: wineVintageId,
    },
  ]);
  await page.getByRole("radio", { exact: true, name: "Consumed" }).click();
  await expect(page).toHaveURL(/status=consumed/u);
  await page.reload();
  await expect(page.locator(".bottle-card")).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath("desktop-consumed-history.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("radio", { exact: true, name: "Consumed" })).toBeChecked();
  await page.screenshot({ path: testInfo.outputPath("phone-consumed-history.png") });
  await page.getByRole("button", { exact: true, name: "View details" }).click();
  detail = page.getByRole("dialog", { exact: true, name: "Bottle details" });
  await expect(detail.getByText("Target slot", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("phone-bottle-details.png") });
  await detail.getByRole("button", { exact: true, name: "Restore to inventory" }).click();
  await page
    .getByRole("dialog", { exact: true, name: "Restore to inventory" })
    .getByRole("button", { exact: true, name: "Restore to inventory" })
    .click();
  await expect(detail.getByText("In stock", { exact: true })).toBeVisible();
  await detail.getByRole("button", { exact: true, name: "Close" }).click();
  await expect(page.locator(".bottle-card")).toHaveCount(0);
  await page.getByRole("radio", { exact: true, name: "In stock" }).click();
  await expect(page.getByText("3 bottles shown", { exact: true }).last()).toBeVisible();
  expect(bottleRows(siteId)).toEqual(
    originalRows.map((row) =>
      row["id"] === targetId
        ? { ...row, position_hint: "Target slot", storage_location_id: secondLocationId }
        : row,
    ),
  );
});

test("retries a lost addition acknowledgement with the committed native D1 receipt exactly once", async ({
  page,
  localCatalogue,
}) => {
  const { siteId, siteName } = localCatalogue;
  const payloads: string[] = [];
  const results: z.infer<typeof additionSchema>["data"][] = [];
  await page.route("**/api/bottles", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    payloads.push(route.request().postData() ?? "");
    const response = await route.fetch();
    expect(response.status(), await response.text()).toBe(201);
    results.push(additionSchema.parse(await response.json()).data);
    if (payloads.length === 1) await route.abort("failed");
    else await route.fulfill({ response });
  });
  await fillAddition(page, siteName, 2);
  const dialog = page.getByRole("dialog", { exact: true, name: "Add bottle" });
  await dialog.getByRole("button", { exact: true, name: "Save bottle" }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "Bottle notes" })).toHaveValue(
    "Bought for the native flow",
  );
  expect(payloads).toHaveLength(1);
  const firstCommit = bottleRows(siteId);
  expect(firstCommit).toHaveLength(2);
  const receiptBeforeRetry = nativeRows(
    "SELECT operation_id, result_json FROM addition_receipts WHERE site_id = ? AND kind = 'bottles'",
    siteId,
  );
  expect(receiptBeforeRetry).toHaveLength(1);
  expect(receiptBeforeRetry[0]?.["operation_id"]).toBe(
    operationSchema.parse(JSON.parse(payloads[0] ?? "")).operationId,
  );
  expect(JSON.parse(String(receiptBeforeRetry[0]?.["result_json"]))).toMatchObject(
    results[0] ?? {},
  );

  await dialog.getByRole("button", { exact: true, name: "Save bottle" }).click();
  await expect(dialog).not.toBeVisible();
  expect(payloads).toHaveLength(2);
  expect(payloads[1]).toBe(payloads[0]);
  expect(results[1]).toEqual(results[0]);
  expect(bottleRows(siteId)).toEqual(firstCommit);
  expect(
    nativeRows(
      "SELECT operation_id, result_json FROM addition_receipts WHERE site_id = ? AND kind = 'bottles'",
      siteId,
    ),
  ).toEqual(receiptBeforeRetry);
  await page.reload();
  await expect(page.getByText("2 bottles shown", { exact: true }).last()).toBeVisible();
});
