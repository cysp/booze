// oxlint-disable import/max-dependencies -- Tests persisted corrections across HTTP, matching, retries, and D1.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createD1Client } from "@chikachow/booze-db";
import { Hono } from "hono";
import { z } from "zod";
import { problemResponseForError } from "./api/http.ts";
import { userIdForClerkUser } from "./api/ids.ts";
import type { Bindings } from "./api/types.ts";
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
  await it("does not clear unresolved alcohol evidence through a notes-only correction", async () => {
    const { sqlite, request } = setup();
    try {
      sqlite.prepare("UPDATE bottle_capture_runs SET import_candidate_json = ?").run(
        JSON.stringify({
          ...candidate,
          validationIssues: [
            {
              path: "wine.alcoholPercent",
              rawValue: "about 14%",
              message: "Enter an unambiguous alcohol percentage.",
            },
          ],
        }),
      );
      const saved = await request("PATCH", "/review", {
        expectedRevision: 0,
        candidate: { ...candidate, wine: { ...candidate.wine, notes: "Check the label" } },
      });
      assert.equal(saved.status, 200, await saved.clone().text());
      const rejected = await request("POST", "/import", { expectedReviewRevision: 1 });
      assert.equal(rejected.status, 400, await rejected.clone().text());
      assert.equal(sqlite.prepare("SELECT count(*) AS count FROM bottles").get()?.["count"], 0);
      const corrected = await request("PATCH", "/review", {
        expectedRevision: 1,
        candidate: { ...candidate, wine: { ...candidate.wine, alcoholPercent: 14 } },
      });
      assert.equal(corrected.status, 200, await corrected.clone().text());
      const imported = await request("POST", "/import", { expectedReviewRevision: 2 });
      assert.equal(imported.status, 200, await imported.clone().text());
    } finally {
      sqlite.close();
    }
  });

  await it("requires a saved correction before manually importing unresolved measurements", async () => {
    for (const reuseWine of [false, true]) {
      const { sqlite, request } = setup();
      try {
        sqlite.exec(
          "INSERT INTO wine_vintages (id,site_id,base_name,display_name,vintage_label) VALUES ('existing','site','Existing','Existing','Unknown')",
        );
        sqlite.prepare("UPDATE bottle_capture_runs SET import_candidate_json = ?").run(
          JSON.stringify({
            ...candidate,
            bottle: {},
            rawSuggestion: { bottleVolumeMl: "750 mL extra" },
            validationIssues: [
              {
                path: "bottle.volumeMl",
                rawValue: "750 mL extra",
                message: "Enter an unambiguous metric volume.",
              },
            ],
          }),
        );
        const choices = reuseWine ? { wineVintageId: "existing" } : {};
        const rejected = await request("POST", "/import", choices);
        assert.equal(rejected.status, 400, await rejected.clone().text());
        assert.match(
          z.object({ detail: z.string() }).parse(await rejected.json()).detail,
          /bottle\.volumeMl.*Save corrected/iu,
        );
        assert.equal(sqlite.prepare("SELECT count(*) AS count FROM bottles").get()?.["count"], 0);
        assert.equal(
          sqlite.prepare("SELECT status FROM bottle_captures").get()?.["status"],
          "needs_review",
        );
        const notesOnly = await request("PATCH", "/review", {
          expectedRevision: 0,
          candidate: { ...candidate, bottle: { notes: "Check label" } },
        });
        assert.equal(notesOnly.status, 200, await notesOnly.clone().text());
        assert.equal(
          (await request("POST", "/import", { ...choices, expectedReviewRevision: 1 })).status,
          400,
        );
        assert.equal(sqlite.prepare("SELECT count(*) AS count FROM bottles").get()?.["count"], 0);
        const correction = await request("PATCH", "/review", { expectedRevision: 1, candidate });
        assert.equal(correction.status, 200, await correction.clone().text());
        const imported = await request("POST", "/import", {
          ...choices,
          expectedReviewRevision: 2,
        });
        assert.equal(imported.status, 200, await imported.clone().text());
        assert.equal(
          sqlite.prepare("SELECT volume_ml FROM bottles LIMIT 1").get()?.["volume_ml"],
          750,
        );
      } finally {
        sqlite.close();
      }
    }
  });

  await it("allows existing-wine selection to discard only unresolved OCR wine facts", async () => {
    const { sqlite, request } = setup();
    try {
      sqlite.exec(
        "INSERT INTO wine_vintages (id,site_id,base_name,display_name,vintage_label,alcohol_percent) VALUES ('existing','site','Existing','Existing','Unknown',12)",
      );
      sqlite.prepare("UPDATE bottle_capture_runs SET import_candidate_json = ?").run(
        JSON.stringify({
          ...candidate,
          rawSuggestion: { alcoholPercent: "about 14%" },
          validationIssues: [
            {
              path: "wine.alcoholPercent",
              rawValue: "about 14%",
              message: "Enter an unambiguous alcohol percentage.",
            },
          ],
        }),
      );
      assert.equal((await request("POST", "/import", {})).status, 400);
      const response = await request("POST", "/import", { wineVintageId: "existing" });
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal(
        sqlite.prepare("SELECT alcohol_percent FROM wine_vintages WHERE id = 'existing'").get()?.[
          "alcohol_percent"
        ],
        12,
      );
    } finally {
      sqlite.close();
    }
  });

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
      await reserveCaptureRetry({
        captureId: "capture",
        database,
        workflowInstanceId: "retry",
        expectedWorkflowInstanceId: null,
        expectedReviewRevision: 1,
        siteId: "site",
        userId: userIdForClerkUser("dev:tester"),
      }),
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
    const { sqlite, request } = setup();
    await request("PATCH", "/review", { expectedRevision: 0, candidate });
    sqlite.exec("UPDATE bottle_captures SET status = 'extracting'");
    const response = await request("POST", "/import", { expectedReviewRevision: 1 });
    assert.equal(response.status, 409);
    assert.equal(sqlite.prepare("SELECT count(*) AS count FROM bottles").get()?.["count"], 0);
  });

  await it("never selects a plausible existing wine without a deliberate wine ID", async () => {
    const { sqlite, request } = setup();
    sqlite.exec(`INSERT INTO wineries (id, site_id, name) VALUES ('winery', 'site', 'RIKARD Wines');
      INSERT INTO wine_vintages (id, site_id, winery_id, base_name, display_name, vintage_year, vintage_status, vintage_label)
      VALUES ('wine', 'site', 'winery', 'Black Label', 'Black Label Shiraz', 2022, 'year', '2022');`);
    const imported = await request("POST", "/import", {});
    assert.equal(imported.status, 200, await imported.clone().text());
    assert.notEqual(
      sqlite.prepare("SELECT wine_vintage_id FROM bottles LIMIT 1").get()?.["wine_vintage_id"],
      "wine",
    );
    assert.equal(sqlite.prepare("SELECT count(*) AS count FROM wine_vintages").get()?.["count"], 2);
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

  await it("reuses an explicitly selected brand without inventing a producer", async () => {
    const { sqlite, request } = setup();
    sqlite.exec(`INSERT INTO wine_vintages (id, site_id, brand_name, base_name, display_name, vintage_label)
      VALUES ('wine', 'site', 'RIKARD', '', 'RIKARD Shiraz', 'Unknown');`);
    const imported = await request("POST", "/import", { wineVintageId: "wine" });
    assert.equal(imported.status, 200, await imported.clone().text());
    assert.equal(sqlite.prepare("SELECT count(*) AS count FROM wineries").get()?.["count"], 0);
    assert.equal(
      sqlite.prepare("SELECT winery_id FROM wine_vintages WHERE id='wine'").get()?.["winery_id"],
      null,
    );
    assert.equal(
      sqlite.prepare("SELECT count(*) AS count FROM bottles WHERE wine_vintage_id='wine'").get()?.[
        "count"
      ],
      2,
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
