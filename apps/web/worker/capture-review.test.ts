// oxlint-disable import/max-dependencies -- Tests persisted corrections across HTTP, matching, retries, and D1.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createD1Client } from "@chikachow/booze-db";
import { Hono } from "hono";
import { z } from "zod";
import { problemResponseForError } from "./api/http.ts";
import { userIdForClerkUser } from "./api/ids.ts";
import type { Bindings } from "./api/types.ts";
import { importBottleCandidate, matchBottleCandidate } from "./bottle-importer.ts";
import { reserveCaptureRetry } from "./capture-store.ts";
import { asD1, migratedDatabase } from "./d1-support.ts";
import { bottleCaptureRoutes } from "./routes/bottle-captures.ts";

const app = new Hono<{ Bindings: Bindings }>()
  .route("/", bottleCaptureRoutes)
  .onError(problemResponseForError);
const candidate = {
  wine: {
    wineryName: "RIKARD Wines",
    grapeVarieties: ["Shiraz"],
    vintageYear: 2022,
    vintageStatus: "year",
  },
  bottle: { volumeMl: 750 },
};

function setup(withRun = true) {
  const sqlite = migratedDatabase();
  const user = userIdForClerkUser("dev:tester");
  sqlite.prepare("INSERT INTO users (id, clerk_user_id) VALUES (?, 'dev:tester')").run(user);
  sqlite.exec("INSERT INTO sites (id, name) VALUES ('site', 'Home')");
  sqlite
    .prepare("INSERT INTO site_memberships (site_id, user_id, role) VALUES ('site', ?, 'owner')")
    .run(user);
  sqlite
    .prepare(
      "INSERT INTO bottle_captures (id, site_id, user_id, status, quantity) VALUES ('capture', 'site', ?, 'needs_review', 2)",
    )
    .run(user);
  if (withRun)
    sqlite
      .prepare(`INSERT INTO bottle_capture_runs (id, capture_id, status, import_candidate_json, extractor_version, prompt_version, schema_version)
    VALUES ('run', 'capture', 'needs_review', ?, 'ocr-v1', 'v1', 'v1')`)
      .run(JSON.stringify(candidate));
  const d1 = asD1(sqlite);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- These route tests only access D1 and local authentication.
  const bindings = { DB: d1 } as Bindings;
  return {
    sqlite,
    database: createD1Client(d1),
    request: async (method: string, suffix: string, payload?: unknown) => {
      return app.request(
        `http://localhost/bottle-captures/capture${suffix}`,
        {
          method,
          headers: { "content-type": "application/json", "x-dev-user": "tester" },
          ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        },
        bindings,
      );
    },
  };
}

await describe("capture review corrections", async () => {
  await it("imports unnamed varietal wine and replays its receipt without duplicate bottles", async () => {
    const { sqlite, request } = setup();
    const first = await request("POST", "/import", {});
    assert.equal(first.status, 200, await first.clone().text());
    const replay = await request("POST", "/import", {});
    assert.deepEqual(await replay.json(), await first.json());
    assert.equal(sqlite.prepare("SELECT count(*) AS count FROM bottles").get()?.["count"], 2);
    assert.equal(
      sqlite.prepare("SELECT designation FROM wine_vintages").get()?.["designation"],
      null,
    );
  });

  await it("persists corrections separately, rejects stale saves/imports, and retains them through retries", async () => {
    const { sqlite, database, request } = setup();
    const before = sqlite.prepare("SELECT import_candidate_json FROM bottle_capture_runs").get();
    const saved = await request("PATCH", "/review", { expectedRevision: 0, candidate });
    assert.equal(saved.status, 200, await saved.clone().text());
    assert.equal(
      (await request("PATCH", "/review", { expectedRevision: 0, candidate })).status,
      409,
    );
    assert.equal((await request("POST", "/import", {})).status, 409);
    assert.deepEqual(
      sqlite.prepare("SELECT import_candidate_json FROM bottle_capture_runs").get(),
      before,
    );
    assert.equal(
      await reserveCaptureRetry({ captureId: "capture", database, workflowInstanceId: "retry" }),
      true,
    );
    const detail = await request("GET", "");
    const body = z
      .object({ data: z.object({ reviewRevision: z.number(), reviewCandidate: z.unknown() }) })
      .parse(await detail.json());
    assert.equal(body.data.reviewRevision, 1);
    assert.deepEqual(body.data.reviewCandidate, {
      ...candidate,
      wine: { ...candidate.wine, designation: "" },
    });
    assert.equal(sqlite.prepare("SELECT count(*) AS count FROM bottles").get()?.["count"], 0);
  });

  await it("supports manual entry after extraction never created a run", async () => {
    const { sqlite, request } = setup(false);
    sqlite.exec("UPDATE bottle_captures SET status = 'failed'");
    assert.equal(
      (
        await request("PATCH", "/review", {
          expectedRevision: 0,
          candidate: { wine: {}, bottle: {} },
        })
      ).status,
      200,
    );
    assert.equal((await request("POST", "/import", { expectedReviewRevision: 1 })).status, 400);
    const imported = await request("POST", "/import", {
      expectedReviewRevision: 1,
      allowUnidentified: true,
    });
    assert.equal(imported.status, 200, await imported.clone().text());
    assert.equal(sqlite.prepare("SELECT winery_id FROM wine_vintages").get()?.["winery_id"], null);
    assert.equal(sqlite.prepare("SELECT count(*) AS count FROM wineries").get()?.["count"], 0);
    assert.equal(
      sqlite.prepare("SELECT count(*) AS count FROM bottle_capture_runs").get()?.["count"],
      1,
    );
    assert.equal(
      (await request("POST", "/import", { expectedReviewRevision: 1, allowUnidentified: true }))
        .status,
      200,
    );
    assert.equal(sqlite.prepare("SELECT count(*) AS count FROM bottles").get()?.["count"], 2);
  });

  await it("requires explicit import after saved corrections even after extraction is retried", async () => {
    const { sqlite, database, request } = setup();
    await request("PATCH", "/review", { expectedRevision: 0, candidate });
    sqlite.exec("UPDATE bottle_captures SET status = 'extracting'");
    const result = await importBottleCandidate({
      database,
      captureId: "capture",
      runId: "run",
      siteId: "site",
      quantity: 2,
      candidate: {
        wine: { wineryName: "Producer", designation: "Reserve" },
        bottle: {},
        rawSuggestion: {},
      },
    });
    assert.equal(result.kind, "needs_review");
    assert.equal(sqlite.prepare("SELECT count(*) AS count FROM bottles").get()?.["count"], 0);
  });

  await it("offers an existing producer/vintage as a possible match, never automatic reuse", async () => {
    const { sqlite, database } = setup();
    sqlite.exec(`INSERT INTO wineries (id, site_id, name) VALUES ('winery', 'site', 'RIKARD Wines');
      INSERT INTO wine_vintages (id, site_id, winery_id, base_name, display_name, vintage_year, vintage_status, vintage_label)
      VALUES ('wine', 'site', 'winery', 'Black Label', 'Black Label Shiraz', 2022, 'year', '2022');`);
    const result = await matchBottleCandidate({
      database,
      siteId: "site",
      candidate: {
        wine: {
          wineryName: "RIKARD Wines",
          designation: "",
          grapeVarieties: ["Shiraz"],
          vintageYear: 2022,
        },
        bottle: {},
        rawSuggestion: {},
      },
    });
    assert.equal(result.kind, "needs_review");
    assert.deepEqual(
      result.wineVintageCandidates.map((wine) => wine.id),
      ["wine"],
    );
  });

  await it("creates a distinct wine when explicitly choosing new despite identical descriptions", async () => {
    const { sqlite, request } = setup();
    sqlite.exec(`INSERT INTO wineries (id, site_id, name) VALUES ('winery', 'site', 'RIKARD Wines');
      INSERT INTO wine_vintages (id, site_id, winery_id, base_name, display_name, vintage_year, vintage_status, vintage_label)
      VALUES ('wine', 'site', 'winery', 'RIKARD Wines', 'RIKARD Shiraz', 2022, 'year', '2022');`);
    const response = await request("POST", "/import", {});
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(sqlite.prepare("SELECT count(*) AS count FROM wine_vintages").get()?.["count"], 2);
    assert.notEqual(
      sqlite.prepare("SELECT wine_vintage_id FROM bottles LIMIT 1").get()?.["wine_vintage_id"],
      "wine",
    );
  });

  await it("rejects corrections during processing and after import without changing the draft", async () => {
    for (const status of ["queued", "extracting", "importing", "imported"]) {
      const { sqlite, request } = setup();
      sqlite.prepare("UPDATE bottle_captures SET status = ?").run(status);
      assert.equal(
        (await request("PATCH", "/review", { expectedRevision: 0, candidate })).status,
        409,
      );
      assert.equal(
        sqlite.prepare("SELECT review_revision FROM bottle_captures").get()?.["review_revision"],
        0,
      );
    }
  });

  await it("returns a field-specific actionable validation error without saving corrections", async () => {
    const { sqlite, request } = setup();
    const response = await request("PATCH", "/review", {
      expectedRevision: 0,
      candidate: { ...candidate, bottle: { volumeMl: 0 } },
    });
    assert.equal(response.status, 400);
    assert.match(response.headers.get("content-type") ?? "", /application\/problem\+json/u);
    const body = z.object({ detail: z.string() }).parse(await response.json());
    assert.match(body.detail, /candidate\.bottle\.volumeMl/u);
    assert.equal(
      sqlite.prepare("SELECT review_revision FROM bottle_captures").get()?.["review_revision"],
      0,
    );
  });

  await it("rejects viewer corrections and contradictory vintage inputs", async () => {
    const { sqlite, request } = setup();
    assert.equal(
      (
        await request("PATCH", "/review", {
          expectedRevision: 0,
          candidate: { ...candidate, wine: { ...candidate.wine, vintageStatus: "non_vintage" } },
        })
      ).status,
      400,
    );
    sqlite.exec("UPDATE site_memberships SET role = 'viewer'");
    assert.equal(
      (await request("PATCH", "/review", { expectedRevision: 0, candidate })).status,
      403,
    );
    assert.equal(
      sqlite.prepare("SELECT review_revision FROM bottle_captures").get()?.["review_revision"],
      0,
    );
  });

  await it("recognizes an existing brand without inventing a producer", async () => {
    const { sqlite, database } = setup();
    sqlite.exec(`INSERT INTO wine_vintages (id, site_id, brand_name, base_name, display_name, vintage_label)
      VALUES ('wine', 'site', 'RIKARD', '', 'RIKARD Shiraz', 'Unknown');`);
    const result = await matchBottleCandidate({
      database,
      siteId: "site",
      candidate: {
        wine: { wineryName: "", brandName: "RIKARD", grapeVarieties: ["Shiraz"] },
        bottle: {},
        rawSuggestion: {},
      },
    });
    assert.equal(result.kind, "needs_review");
    assert.deepEqual(
      result.wineVintageCandidates.map((wine) => wine.id),
      ["wine"],
    );
  });

  await it("does not change shared wine facts when reusing a selected wine", async () => {
    const { sqlite, request } = setup();
    sqlite.exec(`INSERT INTO wineries (id, site_id, name) VALUES ('winery', 'site', 'Existing producer');
      INSERT INTO wine_vintages (id, site_id, winery_id, base_name, display_name, vintage_label, alcohol_percent)
      VALUES ('wine', 'site', 'winery', 'Existing', 'Existing', 'Unknown', 12);`);
    const before = sqlite.prepare("SELECT * FROM wine_vintages").get();
    assert.equal((await request("POST", "/import", { wineVintageId: "wine" })).status, 200);
    assert.deepEqual(sqlite.prepare("SELECT * FROM wine_vintages").get(), before);
  });
});
