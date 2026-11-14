/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-return, typescript/no-unsafe-type-assertion -- Page evaluation runs in Chrome's DOM context rather than the Worker TypeScript environment. */
import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import { createRequire } from "node:module";

import { bottles, captures, locations, sites } from "./catalogue-fixtures.ts";
import { captureSummarySchema } from "../shared/capture-read-resources.ts";
import { bottleSummarySchema } from "../shared/inventory-queries.ts";
import { calculateDrinkStatus } from "../shared/drink-status.ts";
import { processingCaptureStatuses } from "../shared/capture-status.ts";
import { wineOptionSchema } from "../shared/wine-options.ts";

const axePath = createRequire(import.meta.url).resolve("axe-core/axe.min.js");

type CatalogueFixtures = {
  readonly bottleData?: readonly (typeof bottles)[number][];
  readonly captureData?: readonly (typeof captures)[number][];
  readonly locationData?: readonly (typeof locations)[number][];
  readonly siteData?: readonly (typeof sites)[number][];
  readonly successfulDeletes?: boolean;
  readonly successfulRenames?: boolean;
};

type StaleRefreshScenario = {
  mutationCount: number;
  readonly mutationMethod: "DELETE" | "POST";
  readonly mutationPath: string;
  readonly refreshFailurePath: string;
};

function catalogueReadResponse(url: URL, fixtures: CatalogueFixtures): unknown {
  const bottleData = fixtures.bottleData ?? bottles;
  const captureData = fixtures.captureData ?? captures;
  const locationData = fixtures.locationData ?? locations;
  const siteData = fixtures.siteData ?? sites;
  const page = <Item>(data: readonly Item[]) => {
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 100);
    const offset = Number(url.searchParams.get("pageToken")?.replace("page-", "") ?? 0);
    return {
      data: data.slice(offset, offset + limit),
      totalCount: data.length,
      nextPageToken: offset + limit < data.length ? `page-${offset + limit}` : null,
    };
  };
  const captureCounts = {
    processing: captureData.filter((capture) =>
      processingCaptureStatuses.some((status) => capture.status === status),
    ).length,
    imported: captureData.filter((capture) => capture.status === "imported").length,
    actionable: captureData.filter(
      (capture) =>
        capture.status !== "imported" &&
        !processingCaptureStatuses.some((status) => capture.status === status),
    ).length,
  };
  const matchesQuery = (text: string) =>
    text.toLocaleLowerCase().includes((url.searchParams.get("query") ?? "").toLocaleLowerCase());
  if (url.pathname === "/api/catalogue-summary")
    return {
      data: {
        inStockBottleCount: bottleData.filter((bottle) => bottle.status === "in_stock").length,
        drinkQueueBottleCount: bottleData.filter(
          (bottle) =>
            bottle.status === "in_stock" &&
            ["drink-now", "drink-soon", "past-window"].includes(calculateDrinkStatus(bottle)),
        ).length,
        captures: captureCounts,
      },
    };
  if (url.pathname === "/api/bottles") {
    const filtered = bottleData.filter(
      (bottle) =>
        bottle.status === (url.searchParams.get("status") ?? "in_stock") &&
        matchesQuery(
          [
            bottle.wineryName,
            bottle.brandName,
            bottle.displayName,
            bottle.grapeVarieties.join(" "),
            bottle.region,
          ].join(" "),
        ) &&
        (!url.searchParams.has("siteId") || bottle.siteId === url.searchParams.get("siteId")) &&
        (!url.searchParams.has("storageLocationId") ||
          bottle.storageLocationId === url.searchParams.get("storageLocationId")) &&
        (!url.searchParams.has("grapeVariety") ||
          bottle.grapeVarieties.includes(url.searchParams.get("grapeVariety") ?? "")) &&
        (!url.searchParams.has("drinkStatus") ||
          calculateDrinkStatus(bottle) === url.searchParams.get("drinkStatus")),
    );
    return {
      ...page(filtered.map((bottle) => bottleSummarySchema.parse(bottle))),
      facets: {
        grapeVarieties: [
          ...new Set(filtered.flatMap((bottle) => bottle.grapeVarieties)),
        ].toSorted(),
        drinkStatuses: [...new Set(filtered.map((bottle) => calculateDrinkStatus(bottle)))],
      },
    };
  }
  if (url.pathname.startsWith("/api/bottles/")) {
    const id = decodeURIComponent(url.pathname.slice("/api/bottles/".length));
    const bottle = bottleData.find((item) => item.id === id);
    return bottle === undefined ? undefined : { data: bottle };
  }
  if (url.pathname === "/api/wines") {
    const wineData = [
      ...new Map(bottleData.map((bottle) => [bottle.wineVintageId, bottle])).values(),
    ].filter(
      (wine) =>
        wine.siteId === url.searchParams.get("siteId") &&
        matchesQuery([wine.wineryName, wine.displayName, wine.grapeVarieties.join(" ")].join(" ")),
    );
    return page(wineData.map((wine) => wineOptionSchema.parse(wine)));
  }
  if (url.pathname.startsWith("/api/wines/")) {
    const id = decodeURIComponent(url.pathname.slice("/api/wines/".length));
    const wine = bottleData.find((item) => item.wineVintageId === id);
    return wine === undefined
      ? undefined
      : { data: { ...wine, id, bottleCount: 1, inStockBottleCount: 1 } };
  }
  if (url.pathname === "/api/bottle-captures") {
    const data = captureData
      .filter((capture) => url.searchParams.get("view") === "all" || capture.status !== "imported")
      .map((capture) =>
        captureSummarySchema.parse({
          ...capture,
          imageCount: capture.images.length,
          previewImage: capture.images[0] ?? null,
        }),
      );
    return { ...page(data), counts: captureCounts };
  }
  if (url.pathname === "/api/bottle-capture-statuses") {
    const ids = new Set(url.searchParams.getAll("captureId"));
    return {
      data: captureData
        .filter((capture) => ids.has(capture.id))
        .map(({ id, status, updatedAt, errorMessage }) => ({
          id,
          status,
          updatedAt,
          errorMessage,
        })),
    };
  }
  if (url.pathname.startsWith("/api/bottle-captures/")) {
    const id = decodeURIComponent(url.pathname.slice("/api/bottle-captures/".length));
    const capture = captureData.find((item) => item.id === id);
    return capture === undefined ? undefined : { data: capture };
  }
  if (url.pathname === "/api/storage-locations") return { data: locationData };
  if (url.pathname === "/api/sites") return { data: siteData };
  return undefined;
}

async function fulfillSuccessfulRename(
  route: Route,
  locationData: readonly (typeof locations)[number][],
  siteData: readonly (typeof sites)[number][],
): Promise<{
  readonly locationData: readonly (typeof locations)[number][];
  readonly siteData: readonly (typeof sites)[number][];
}> {
  const request = route.request();
  const path = new URL(request.url()).pathname;
  const id = path.split("/").at(-1);
  const payload: unknown = request.postDataJSON();
  const name =
    typeof payload === "object" &&
    payload !== null &&
    "name" in payload &&
    typeof payload.name === "string"
      ? payload.name
      : null;
  let nextLocationData = locationData;
  let nextSiteData = siteData;
  if (name === null) {
    await route.fulfill({ body: "Invalid rename payload", status: 400 });
    return { locationData: nextLocationData, siteData: nextSiteData };
  }
  if (path.startsWith("/api/storage-locations/")) {
    nextLocationData = locationData.map((location) =>
      location.id === id ? { ...location, name } : location,
    );
  } else if (path.startsWith("/api/sites/")) {
    nextSiteData = siteData.map((site) => (site.id === id ? { ...site, name } : site));
  } else {
    await route.fulfill({ body: `Unexpected PATCH ${path}`, status: 501 });
    return { locationData: nextLocationData, siteData: nextSiteData };
  }
  await route.fulfill({ body: "{}", contentType: "application/json", status: 200 });
  return { locationData: nextLocationData, siteData: nextSiteData };
}

async function mockCatalogue(page: Page, fixtures: CatalogueFixtures = {}): Promise<void> {
  let bottleData = fixtures.bottleData ?? bottles;
  let captureData = fixtures.captureData ?? captures;
  let locationData = fixtures.locationData ?? locations;
  let siteData = fixtures.siteData ?? sites;
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (method === "PATCH" && fixtures.successfulRenames === true) {
      ({ locationData, siteData } = await fulfillSuccessfulRename(route, locationData, siteData));
      return;
    }
    if (method === "DELETE" && fixtures.successfulDeletes === true) {
      const id = path.split("/").at(-1);
      if (path.startsWith("/api/bottle-captures/")) {
        captureData = captureData.filter((capture) => capture.id !== id);
      } else if (path.startsWith("/api/storage-locations/")) {
        locationData = locationData.filter((location) => location.id !== id);
      } else if (path.startsWith("/api/sites/")) {
        siteData = siteData.filter((site) => site.id !== id);
      } else if (path.startsWith("/api/bottles/")) {
        bottleData = bottleData.filter((bottle) => bottle.id !== id);
      } else {
        await route.fulfill({ body: `Unexpected DELETE ${path}`, status: 501 });
        return;
      }
      await route.fulfill({ body: "{}", contentType: "application/json", status: 200 });
      return;
    }
    if (
      (method === "DELETE" || method === "PATCH" || method === "POST") &&
      /^\/api\/(?:bottles|storage-locations|sites|bottle-captures)(?:\/[^/]+(?:\/(?:import|retry))?)?$/u.test(
        path,
      )
    ) {
      await route.fulfill({ body: "forced browser-test failure", status: 500 });
      return;
    }
    const data =
      method === "GET"
        ? catalogueReadResponse(new URL(request.url()), {
            bottleData,
            captureData,
            locationData,
            siteData,
          })
        : undefined;
    if (data === undefined) {
      await route.fulfill({
        body: `Unexpected browser-test request: ${method} ${path}`,
        status: 501,
      });
      return;
    }
    await route.fulfill({
      body: JSON.stringify(data),
      contentType: "application/json",
      status: 200,
    });
  });
}

async function expectNoAxeViolations(page: Page): Promise<void> {
  await expect
    .poll(async () =>
      page.evaluate(() =>
        [...document.querySelectorAll("dialog[open]")].every(
          (dialog) => getComputedStyle(dialog).opacity === "1",
        ),
      ),
    )
    .toBe(true);
  await page.addScriptTag({ path: axePath });
  const violations = await page.evaluate(async () => {
    const axe = (
      window as unknown as {
        axe: {
          run: () => Promise<{
            violations: readonly {
              id: string;
              nodes: readonly { failureSummary: string; target: readonly string[] }[];
            }[];
          }>;
        };
      }
    ).axe;
    return (await axe.run()).violations.map((violation) => ({
      id: violation.id,
      nodes: violation.nodes.map((node) => ({
        failureSummary: node.failureSummary,
        target: node.target,
      })),
    }));
  });
  expect(violations).toEqual([]);
}

async function mockCommittedMutationWithStaleRefresh(
  page: Page,
  scenario: StaleRefreshScenario,
): Promise<void> {
  let bottleData = bottles;
  let failRefresh = false;
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (method === scenario.mutationMethod && path === scenario.mutationPath) {
      scenario.mutationCount += 1;
      failRefresh = true;
      if (method === "DELETE" && path.startsWith("/api/bottles/")) {
        const bottleId = path.split("/").at(-1);
        bottleData = bottleData.filter((bottle) => bottle.id !== bottleId);
      }
      await route.fulfill({
        body:
          method === "POST"
            ? JSON.stringify({
                data: { captureId: "submitted-capture", errorMessage: null, intakeComplete: true },
              })
            : JSON.stringify({}),
        contentType: "application/json",
        status: 200,
      });
      return;
    }
    if (method === "GET" && failRefresh && path === scenario.refreshFailurePath) {
      failRefresh = false;
      await route.fulfill({ body: "forced stale refresh", status: 503 });
      return;
    }
    const data =
      method === "GET" ? catalogueReadResponse(new URL(request.url()), { bottleData }) : undefined;
    if (data === undefined) {
      await route.fulfill({
        body: `Unexpected browser-test request: ${method} ${path}`,
        status: 501,
      });
      return;
    }
    await route.fulfill({
      body: JSON.stringify(data),
      contentType: "application/json",
      status: 200,
    });
  });
}

async function failDestructiveAction(
  page: Page,
  trigger: Locator,
  dialogName: string,
  actionName: string,
  failureMessage: string,
): Promise<void> {
  await trigger.focus();
  await trigger.press("Enter");
  const dialog = page.getByRole("alertdialog", { name: dialogName });
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  const action = dialog.getByRole("button", { name: actionName });
  await action.focus();
  await action.press("Enter");
  await expect(dialog.getByRole("alert")).toContainText(failureMessage);
  await expect(page.getByRole("alert").filter({ hasText: /\S/u })).toHaveCount(1);
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await expect(dialog).toBeVisible();
  await expectNoAxeViolations(page);
  await action.focus();
  await expect(action).toBeFocused();
  for (let index = 0; index < 4; index += 1) {
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
}

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mockCatalogue(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Browse bottles" })).toBeVisible();
});

test("reads bounded page resources and opens capture/bottle detail only on demand", async ({
  page,
}) => {
  const reads: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname.startsWith("/api/")) reads.push(url.pathname);
  });
  await page.reload();
  await expect(page.locator(".bottle-card")).toHaveCount(1);
  expect(reads).not.toContain("/api/bottle-captures");
  expect(reads).not.toContain("/api/wines");
  expect(reads).not.toContain("/api/bottles/bottle-1");

  const captureList = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/bottle-captures",
  );
  await page.getByRole("button", { name: "Capture" }).click();
  const summaryResponse = await captureList;
  const body = await summaryResponse.json();
  expect(body.data).toHaveLength(1);
  expect(body.data[0]).not.toHaveProperty("latestRun");
  expect(body.data[0]).not.toHaveProperty("reviewCandidate");
  expect(reads).not.toContain("/api/bottle-captures/capture-1");
  expect(reads).not.toContain("/api/wines");
  await page.getByRole("button", { name: "Review capture" }).click();
  await expect(
    page.locator("summary", { hasText: "Review wine and bottle details" }),
  ).toBeVisible();
  expect(reads.filter((path) => path === "/api/bottle-captures/capture-1")).toHaveLength(1);

  await page.getByRole("button", { name: "Inventory", exact: true }).click();
  await page.locator(".bottle-card").first().getByRole("button", { name: "View details" }).click();
  await expect(page.getByRole("dialog", { name: "Bottle details" })).toBeVisible();
  expect(reads.filter((path) => path === "/api/bottles/bottle-1")).toHaveLength(1);
});

test("toggles capture evidence and full errors with the keyboard", async ({ page }) => {
  const errorMessage = "Extraction needs review\nThe models disagree on the vintage year.";
  await page.route("**/api/bottle-captures/capture-1", async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        data: {
          ...captures[0],
          errorMessage,
          latestRun: {
            id: "run-review",
            status: "needs_review",
            extractionR2Key: null,
            extractionContentType: null,
            extractionSizeBytes: null,
            importCandidate: {
              wine: { wineryName: "Rowlee", displayName: "Reserve Shiraz", vintageYear: 2023 },
              bottle: { volumeMl: 750 },
            },
            matchResult: null,
            importResult: { reviewReasons: ["Check the year against the retained photos."] },
            errorMessage: null,
            errorDetailR2Key: null,
            errorDetailContentType: null,
            errorDetailSizeBytes: null,
            createdAt: captures[0]?.createdAt,
            completedAt: null,
          },
        },
      }),
      contentType: "application/json",
      status: 200,
    });
  });
  await page.reload();
  await page.getByRole("button", { name: "Capture" }).click();
  await page.getByRole("button", { name: "Review capture" }).click();

  const review = page.locator("summary", { hasText: "Review wine and bottle details" });
  const reason = page.getByText("Check the year against the retained photos.");
  await expect(reason).toBeVisible();
  await review.focus();
  await review.press("Enter");
  await expect(reason).toBeHidden();
  await expect(review).toBeFocused();
  await review.press("Space");
  await expect(reason).toBeVisible();

  const issue = page.locator("summary", { hasText: "Extraction needs review" });
  const fullError = page.getByText(errorMessage, { exact: true });
  await expect(fullError).toBeHidden();
  await issue.focus();
  await issue.press("Enter");
  await expect(fullError).toBeVisible();
  await expectNoAxeViolations(page);
  await issue.press("Space");
  await expect(fullError).toBeHidden();
  await expect(issue).toBeFocused();
});

test("persists navigation and filters while remaining accessible at reduced motion and reflow", async ({
  page,
}) => {
  expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(
    true,
  );
  expect(
    await page.evaluate(() =>
      document
        .getAnimations()
        .every((animation) => Number(animation.effect?.getTiming().duration ?? 0) <= 1),
    ),
  ).toBe(true);
  await expectNoAxeViolations(page);

  await page.getByRole("textbox", { name: "Search bottles" }).fill("Shiraz");
  await expect(page).toHaveURL(/\?q=Shiraz/u);
  await page.getByRole("radio", { name: "Storage" }).click();
  await expect(page).toHaveURL(/grouping=storage/u);

  await page.getByRole("button", { name: "Capture" }).click();
  await expect(page.getByRole("heading", { name: "Photograph bottles" })).toBeVisible();
  await expect(page).toHaveURL(/area=captures/u);
  await expect(page.getByRole("textbox", { name: "Position note" })).toBeVisible();
  await expectNoAxeViolations(page);

  await page.getByRole("button", { name: "Storage" }).click();
  await expect(page.getByRole("heading", { name: "Sites and locations" })).toBeVisible();
  await expectNoAxeViolations(page);
  const useForBottle = page.getByRole("button", { name: "Use for bottle" }).first();
  await useForBottle.focus();
  await useForBottle.press("Enter");
  await expect(page.getByRole("dialog", { name: "Add bottle" })).toBeVisible();
  await expectNoAxeViolations(page);
  await page.keyboard.press("Escape");
  await expect(useForBottle).toBeFocused();

  await page.getByRole("button", { name: "Inventory" }).click();
  const addBottle = page.getByRole("button", { name: "Add bottle" });
  await addBottle.focus();
  await addBottle.press("Enter");
  await expect(page.getByRole("dialog", { name: "Add bottle" })).toBeVisible();
  expect(
    await page.evaluate(() =>
      document
        .getAnimations()
        .every((animation) => Number(animation.effect?.getTiming().duration ?? 0) <= 1),
    ),
  ).toBe(true);
  await page.keyboard.press("Escape");
  await expect(addBottle).toBeFocused();

  const editBottle = page
    .locator(".bottle-card")
    .first()
    .getByRole("button", { name: "View details" });
  await editBottle.focus();
  await editBottle.press("Enter");
  await expect(page.getByRole("dialog", { name: "Bottle details" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(editBottle).toBeFocused();

  await page.setViewportSize({ width: 320, height: 720 });
  await expect(page.getByRole("textbox", { name: "Search bottles" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add bottle" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test("keeps failed editor values and rejects malformed award numbers", async ({ page }) => {
  await page.locator(".bottle-card").first().getByRole("button", { name: "View details" }).click();
  await page
    .getByRole("dialog", { name: "Bottle details" })
    .getByRole("button", { name: "Correct shared wine" })
    .click();
  const dialog = page.getByRole("dialog", { name: "Correct shared wine" });
  await expectNoAxeViolations(page);
  await expect(dialog.getByText(/Corrections will update all/u)).toBeVisible();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  const winery = dialog.getByRole("textbox", { name: /Winery/u });
  await winery.fill("Unsaved Browser Winery");
  await dialog.getByText("Wine reference and evidence", { exact: true }).click();
  await dialog.getByRole("button", { name: "Add review" }).click();
  await dialog.locator("[name='criticReviews.0.reviewSourceName']").fill("Browser critic");
  await dialog.locator("[name='criticReviews.0.ratingText']").fill("96 points");
  await dialog.getByRole("button", { name: "Add award" }).click();
  await dialog.locator("[name='awards.0.awardLevel']").fill("Gold");
  await dialog.locator("[name='awards.0.awardName']").fill("Browser show");
  const awardPoints = dialog.locator("[name='awards.0.points']");
  await awardPoints.fill("0x10");
  await dialog.getByRole("button", { name: "Save wine corrections" }).click();
  await expect(awardPoints).toHaveAttribute("aria-invalid", "true");
  await expect(awardPoints).toHaveAccessibleDescription("Points must be a decimal number.");
  await expect(
    dialog.locator(".astryx-field-status", { hasText: /^Points must be a decimal number\.$/u }),
  ).toBeVisible();

  await awardPoints.fill("95");
  await dialog.getByRole("button", { name: "Save wine corrections" }).click();
  await expect(
    dialog.getByRole("alert").filter({ hasText: "Bottle was not updated." }),
  ).toBeVisible();
  await expect(winery).toHaveValue("Unsaved Browser Winery");
  await expect(dialog.locator("[name='criticReviews.0.ratingText']")).toHaveValue("96 points");
  await expect(dialog.locator("[name='awards.0.awardName']")).toHaveValue("Browser show");
});

test("keeps named resource rename state on failure and completes successful renames", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Storage" }).click();
  let locationsRegion = page.getByRole("region", { exact: true, name: "Locations" });
  await locationsRegion.getByRole("button", { name: "Edit" }).first().click();
  const failedLocationName = locationsRegion.getByRole("textbox", {
    name: "Location display name",
  });
  await failedLocationName.fill("Lower rack");
  await locationsRegion.getByRole("button", { exact: true, name: "Save" }).click();
  await expect(locationsRegion.getByText("Location was not updated. Try again.")).toBeVisible();
  await expect(failedLocationName).toHaveValue("Lower rack");

  await page.unroute("**/api/**");
  await mockCatalogue(page, { successfulRenames: true });
  await page.reload();
  await page.getByRole("button", { name: "Storage" }).click();

  locationsRegion = page.getByRole("region", { exact: true, name: "Locations" });
  await locationsRegion.getByRole("button", { name: "Edit" }).first().click();
  const locationName = locationsRegion.getByRole("textbox", {
    name: "Location display name",
  });
  await locationName.fill("Lower rack");
  await locationsRegion.getByRole("button", { exact: true, name: "Save" }).click();
  await expect(
    locationsRegion.getByRole("heading", { exact: true, name: "Lower rack" }),
  ).toBeVisible();
  await expect(page.getByText("Location updated.", { exact: true })).toBeVisible();

  const sitesRegion = page.getByRole("region", { exact: true, name: "Sites" });
  await sitesRegion.getByRole("button", { name: "Edit" }).click();
  const siteName = sitesRegion.getByRole("textbox", { name: "Site display name" });
  await siteName.fill("Home collection");
  await sitesRegion.getByRole("button", { exact: true, name: "Save" }).click();
  await expect(sitesRegion.getByRole("heading", { name: "Home collection" })).toBeVisible();
  await expect(page.getByText("Site updated.", { exact: true })).toBeVisible();
});

test("keeps every destructive failure inside its active nested dialog", async ({ page }) => {
  const bottleCard = page.locator(".bottle-card").first();
  await bottleCard.getByRole("button", { name: "View details" }).click();
  const bottleDialog = page.getByRole("dialog", { name: "Bottle details" });
  await failDestructiveAction(
    page,
    bottleDialog.getByRole("button", { name: "Delete bottle" }),
    "Delete this bottle?",
    "Delete bottle",
    "Bottle was not deleted",
  );
  await bottleDialog.getByRole("button", { name: "Close" }).click();

  await page.getByRole("button", { name: "Capture" }).click();
  await failDestructiveAction(
    page,
    page.getByRole("button", { name: "Delete capture" }),
    "Delete this capture?",
    "Delete capture",
    "Delete failed",
  );

  await page.getByRole("button", { name: "Storage" }).click();
  const locationsRegion = page.getByRole("region", { exact: true, name: "Locations" });
  await failDestructiveAction(
    page,
    locationsRegion.getByRole("button", { name: "Delete" }).first(),
    "Delete Left rack?",
    "Delete location",
    "Location was not deleted",
  );
  const sitesRegion = page.getByRole("region", { exact: true, name: "Sites" });
  await failDestructiveAction(
    page,
    sitesRegion.getByRole("button", { name: "Delete" }),
    "Delete Home cellar?",
    "Delete site",
    "Site was not deleted",
  );
});

test("keeps successful destructive lifecycles mounted through reload and restores safe focus", async ({
  page,
}) => {
  await page.unroute("**/api/**");
  await mockCatalogue(page, { successfulDeletes: true });
  await page.reload();

  await page.locator(".bottle-card").first().getByRole("button", { name: "View details" }).click();
  const bottleDialog = page.getByRole("dialog", { name: "Bottle details" });
  await bottleDialog.getByRole("button", { name: "Delete bottle" }).click();
  const bottleDeleteDialog = page.getByRole("alertdialog", { name: "Delete this bottle?" });
  await bottleDeleteDialog.getByRole("button", { name: "Delete bottle" }).click();
  await expect(bottleDialog).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Add bottle" })).toBeFocused();

  await page.getByRole("button", { name: "Capture" }).click();
  await page.getByRole("button", { name: "Delete capture" }).click();
  const captureDialog = page.getByRole("alertdialog", { name: "Delete this capture?" });
  await captureDialog.getByRole("button", { name: "Delete capture" }).click();
  await expect(captureDialog).not.toBeVisible();
  await expect(page.getByRole("heading", { name: "Action needed" })).toBeFocused();

  await page.getByRole("button", { name: "Storage" }).click();
  const locationsRegion = page.getByRole("region", { exact: true, name: "Locations" });
  await locationsRegion.getByRole("button", { name: "Delete" }).first().click();
  const locationDialog = page.getByRole("alertdialog", { name: "Delete Left rack?" });
  await locationDialog.getByRole("button", { name: "Delete location" }).click();
  await expect(locationDialog).not.toBeVisible();
  await expect(page.getByRole("heading", { exact: true, name: "Locations" })).toBeFocused();

  const sitesRegion = page.getByRole("region", { exact: true, name: "Sites" });
  await sitesRegion.getByRole("button", { name: "Delete" }).click();
  const siteDialog = page.getByRole("alertdialog", { name: "Delete Home cellar?" });
  await siteDialog.getByRole("button", { name: "Delete site" }).click();
  await expect(siteDialog).not.toBeVisible();
  await expect(page.getByRole("heading", { exact: true, name: "Sites" })).toBeFocused();
});

test("treats a committed delete as successful when catalogue refresh fails", async ({ page }) => {
  await page.unroute("**/api/**");
  const scenario: StaleRefreshScenario = {
    mutationCount: 0,
    mutationMethod: "DELETE",
    mutationPath: "/api/bottles/bottle-1",
    refreshFailurePath: "/api/bottles",
  };
  await mockCommittedMutationWithStaleRefresh(page, scenario);
  await page.reload();

  await page.locator(".bottle-card").first().getByRole("button", { name: "View details" }).click();
  const bottleDialog = page.getByRole("dialog", { name: "Bottle details" });
  await bottleDialog.getByRole("button", { name: "Delete bottle" }).click();
  const deleteDialog = page.getByRole("alertdialog", { name: "Delete this bottle?" });
  await deleteDialog.getByRole("button", { name: "Delete bottle" }).click();

  await expect(deleteDialog).not.toBeVisible();
  await expect(bottleDialog).not.toBeVisible();
  await expect(
    page.getByRole("alert", {
      name: "Inventory could not be refreshed. Try again.",
    }),
  ).toBeVisible();
  expect(scenario.mutationCount).toBe(1);

  await page.getByRole("button", { name: "Retry refresh" }).click();
  await expect(page.getByText("Latest data refreshed.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry refresh" })).not.toBeVisible();
  await expect(page.locator(".bottle-card")).toHaveCount(0);
  expect(scenario.mutationCount).toBe(1);
});

test("clears submitted capture files without duplicating a committed capture", async ({ page }) => {
  await page.unroute("**/api/**");
  const scenario: StaleRefreshScenario = {
    mutationCount: 0,
    mutationMethod: "POST",
    mutationPath: "/api/bottle-captures",
    refreshFailurePath: "/api/bottle-captures",
  };
  await mockCommittedMutationWithStaleRefresh(page, scenario);
  await page.reload();
  await page.getByRole("button", { name: "Capture" }).click();

  await page.locator("#capture-bottle-photos").setInputFiles({
    buffer: Buffer.from("browser capture"),
    mimeType: "image/jpeg",
    name: "bottle.jpg",
  });
  await expect(page.getByText("1 of 4 selected.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Submit capture" }).click();

  await expect(
    page.getByText("Capture submitted. Review the extracted draft before adding bottles.", {
      exact: true,
    }),
  ).toBeVisible();
  // The app status region announces this outcome; the visible copy must not announce it again.
  const submittedBanner = page.locator(".astryx-banner-frame").filter({
    hasText: "Capture submitted. Review the extracted draft before adding bottles.",
  });
  await expect(submittedBanner).not.toHaveAttribute("role");
  await expect(submittedBanner).not.toHaveAttribute("aria-live");
  await expect(page.getByText("0 of 4 selected.", { exact: false })).toBeVisible();
  await expect(
    page.getByRole("alert", {
      name: "Captures could not be refreshed. Try again.",
    }),
  ).toBeVisible();
  expect(scenario.mutationCount).toBe(1);

  await page.getByRole("button", { name: "Retry refresh" }).click();
  await expect(page.getByText("Latest data refreshed.", { exact: true })).toBeVisible();
  expect(scenario.mutationCount).toBe(1);
});

test("recovers from a rejected cold workspace chunk", async ({ page }) => {
  const captureChunk = "**/src/CaptureView.tsx*";
  await page.route(captureChunk, async (route) => {
    await route.abort();
  });

  await page.getByRole("button", { name: "Capture" }).click();
  const recovery = page.getByRole("alert", {
    name: "Cellar workspace could not be loaded",
  });
  await expect(recovery).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: /\S/u })).toHaveCount(1);
  await expect(recovery.getByRole("button", { name: "Retry" })).toBeFocused();
  await expectNoAxeViolations(page);

  await page.unroute(captureChunk);
  await recovery.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByRole("heading", { name: "Photograph bottles" })).toBeVisible();
});

test("keeps a representative large catalogue scrollable and focusable", async ({ page }) => {
  await page.unroute("**/api/**");
  const largeCatalogue = Array.from({ length: 160 }, (_, index) => ({
    ...bottles[0],
    displayName: `Scale bottle ${String(index).padStart(3, "0")}`,
    id: `scale-bottle-${index}`,
    wineVintageId: `scale-vintage-${index}`,
  }));
  await mockCatalogue(page, { bottleData: largeCatalogue });
  await page.reload();

  const cards = page.locator(".bottle-card");
  await expect(cards).toHaveCount(50);
  await expect(page.getByText("Showing 50 of 160 matching bottles")).toBeVisible();
  await page.getByRole("button", { name: "Load more", exact: true }).click();
  await expect(cards).toHaveCount(100);
  const firstRevealedCard = cards.nth(50);
  await expect(firstRevealedCard).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(firstRevealedCard.getByRole("button", { name: "View details" })).toBeFocused();
  await page.getByRole("button", { name: "Load more", exact: true }).click();
  await expect(cards).toHaveCount(150);
  await page.getByRole("button", { name: "Load more", exact: true }).click();
  await expect(cards).toHaveCount(160);
  const inventoryStatus = page.locator(".inventory-pagination [role='status']");
  await expect(inventoryStatus).toHaveText("Showing 160 of 160 matching bottles");
  const lastEdit = cards.last().getByRole("button", { name: "View details" });
  await lastEdit.scrollIntoViewIfNeeded();
  await expect(lastEdit).toBeVisible();
  await lastEdit.focus();
  await expect(lastEdit).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test("bounds capture, site, and location work before progressively revealing it", async ({
  page,
}) => {
  const captureData = Array.from({ length: 80 }, (_, index) => ({
    ...captures[0],
    id: `scale-capture-${index}`,
    siteId: "scale-site-0",
    siteName: "Scale site 0",
  }));
  const siteData = Array.from({ length: 80 }, (_, index) => ({
    ...sites[0],
    id: `scale-site-${index}`,
    name: `Scale site ${index}`,
  }));
  const locationData = Array.from({ length: 80 }, (_, index) => ({
    ...locations[0],
    id: `scale-location-${index}`,
    name: `Scale location ${index}`,
    parentId: null,
    siteId: "scale-site-0",
    siteName: "Scale site 0",
  }));
  await page.unroute("**/api/**");
  await mockCatalogue(page, { captureData, locationData, siteData });
  await page.reload();

  await page.getByRole("button", { name: "Capture" }).click();
  await expect(page.locator(".capture-card")).toHaveCount(50);
  await page.getByRole("button", { name: "Load more", exact: true }).click();
  await expect(page.locator(".capture-card")).toHaveCount(80);
  const captureStatus = page.locator(".inventory-pagination [role='status']");
  await expect(captureStatus).toHaveText("Showing 80 of 80 matching captures");
  const firstRevealedCapture = page.locator(".capture-card").nth(50);
  await expect(firstRevealedCapture).toBeFocused();
  await page.keyboard.press("Tab");
  const reviewTrigger = firstRevealedCapture.getByRole("button", { name: "Review capture" });
  await expect(reviewTrigger).toBeFocused();
  await reviewTrigger.press("Enter");
  await expect(
    firstRevealedCapture.getByRole("button", { name: "Add bottles as new wine" }),
  ).toBeDisabled();
  await expect(
    firstRevealedCapture.locator("summary", { hasText: "Review wine and bottle details" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Storage" }).click();
  const sitesRegion = page.getByRole("region", { exact: true, name: "Sites" });
  await expect(sitesRegion.locator(".location-card")).toHaveCount(50);
  await sitesRegion.getByRole("button", { name: "Show 30 more" }).click();
  await expect(sitesRegion.locator(".location-card")).toHaveCount(80);
  await expect(sitesRegion.locator(".inventory-pagination [role='status']")).toHaveText(
    "Showing all 80 sites",
  );
  const firstRevealedSite = sitesRegion.locator(".location-card").nth(50);
  await expect(firstRevealedSite).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(firstRevealedSite.getByRole("button", { name: "Edit" })).toBeFocused();

  const locationsRegion = page.getByRole("region", { exact: true, name: "Locations" });
  await expect(locationsRegion.locator(".location-card")).toHaveCount(50);
  await locationsRegion.getByRole("button", { name: "Show 30 more" }).click();
  await expect(locationsRegion.locator(".location-card")).toHaveCount(80);
  await expect(locationsRegion.locator(".inventory-pagination [role='status']")).toHaveText(
    "Showing all 80 locations",
  );
  const firstRevealedLocation = locationsRegion.locator(".location-card").nth(50);
  await expect(firstRevealedLocation).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(firstRevealedLocation.getByRole("button", { name: "Use for bottle" })).toBeFocused();
});

test("astryx regression: selector stays closed after trigger light dismiss", async ({ page }) => {
  const selector = page.getByRole("combobox", { name: "Varietal" });
  await selector.click();
  await expect(selector).toHaveAttribute("aria-expanded", "true");
  await selector.evaluate(async (trigger) => {
    trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    const popup = document.querySelector("[popover]:popover-open");
    if (!(popup instanceof HTMLElement)) throw new Error("Missing open selector popup");
    popup.hidePopover();
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await expect(selector).toHaveAttribute("aria-expanded", "false");
});

test("astryx regression: quantity accepts pasted fullwidth digits", async ({ page }) => {
  await page.getByRole("button", { name: "Add bottle" }).click();
  const quantity = page
    .getByRole("dialog", { name: "Add bottle" })
    .locator("input[name='quantity']");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate(() => navigator.clipboard.writeText("１２"));
  await quantity.focus();
  await quantity.press("ControlOrMeta+A");
  await quantity.press("ControlOrMeta+V");
  await quantity.press("Tab");
  await expect(quantity).toHaveValue("１２");
});

test("astryx regression: in-place navigation is marked current item", async ({ page }) => {
  await expect(page.getByRole("button", { name: "Inventory", exact: true })).toHaveAttribute(
    "aria-current",
    "true",
  );
});

test.describe("phone theme", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

  test("uses readable phone typography and keeps destructive errors accessible", async ({
    page,
  }, testInfo) => {
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    await expect(page.getByRole("textbox", { name: "Search bottles" })).toHaveCSS(
      "font-size",
      "16px",
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );

    await page
      .locator(".bottle-card")
      .first()
      .getByRole("button", { name: "View details" })
      .click();
    await page
      .getByRole("dialog", { name: "Bottle details" })
      .getByRole("button", { name: "Delete bottle" })
      .click();
    const dialog = page.getByRole("alertdialog", { name: "Delete this bottle?" });
    await dialog.getByRole("button", { name: "Delete bottle" }).click();
    await expect(dialog.getByRole("alert")).toContainText("Bottle was not deleted");
    await expect(page.getByRole("alert").filter({ hasText: /\S/u })).toHaveCount(1);
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await expectNoAxeViolations(page);
    await page.screenshot({ path: testInfo.outputPath("phone-destructive-error.png") });
  });
});
