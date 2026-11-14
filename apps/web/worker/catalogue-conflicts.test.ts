// oxlint-disable import/max-dependencies -- Exercises bottle and capture transactions through their HTTP and persistence boundaries.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DatabaseSync } from "node:sqlite";

import { createD1Client } from "@chikachow/booze-db";
import { Hono } from "hono";

import { retryCatalogueTransaction } from "./api/catalogue-transaction.ts";
import { problemResponseForError } from "./api/http.ts";
import { userIdForClerkUser } from "./api/ids.ts";
import type { Bindings } from "./api/types.ts";
import { importBottleCandidate } from "./bottle-importer.ts";
import { asD1, migratedDatabase } from "./d1-support.ts";
import { bottleCaptureRoutes } from "./routes/bottle-captures.ts";
import { bottleRoutes } from "./routes/bottles.ts";

const wine = { wineryName: "Producer", designation: "Reserve", vintageYear: 2020 };
const candidate = { wine, bottle: {}, rawSuggestion: {} };
const app = new Hono<{ Bindings: Bindings }>()
  .route("/", bottleRoutes)
  .route("/", bottleCaptureRoutes)
  .onError(problemResponseForError);

await describe("catalogue preparation conflicts", async () => {
  await it("keeps a bottle addition distinct from a concurrent wine with the same description", async () => {
    const sqlite = setup();
    const { d1, batchCount } = interleavedDatabase(sqlite, (attempt) => {
      if (attempt === 1) insertWinningVintage(sqlite, "winner");
    });
    const response = await request(d1, "/bottles", {
      siteId: "site",
      storageLocationId: "location",
      quantity: 2,
      wine: { ...wine, notes: "Extracted notes" },
      labelExtraction: { extractedFieldsJson: "{}" },
      criticReviews: [{ reviewSourceId: "source", ratingText: "95" }],
      awards: [{ awardName: "Show", awardLevel: "Gold", awardYear: 2025 }],
    });
    assert.equal(response.status, 201, await response.clone().text());
    assert.equal(batchCount(), 1);
    const body = await response.json();
    assert.ok(typeof body === "object" && body !== null && "data" in body);
    assert.ok(typeof body.data === "object" && body.data !== null && "wineVintageId" in body.data);
    assert.notEqual(body.data.wineVintageId, "winner");
    assert.equal(sqlite.prepare("SELECT count(*) AS count FROM wine_vintages").get()?.["count"], 2);
    assert.equal(sqlite.prepare("SELECT count(*) AS count FROM bottles").get()?.["count"], 2);
    for (const table of ["bottles", "label_extractions", "critic_reviews", "wine_awards"]) {
      assert.deepEqual(
        sqlite
          .prepare(`SELECT DISTINCT wine_vintage_id FROM ${table}`)
          .all()
          .map((row) => row["wine_vintage_id"]),
        [body.data.wineVintageId],
      );
    }
    assert.equal(
      sqlite.prepare("SELECT notes FROM wine_vintages WHERE id = 'winner'").get()?.["notes"],
      "Existing notes",
    );
    assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
  });

  await it("keeps explicit manual creation distinct from a concurrent same-description wine", async () => {
    const sqlite = setup();
    insertCapture(sqlite, "needs_review");
    const { d1, batchCount } = interleavedDatabase(sqlite, (attempt) => {
      if (attempt === 1) insertWinningVintage(sqlite, "winner");
    });
    const response = await request(d1, "/bottle-captures/capture/import", {});
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(batchCount(), 1);
    const importedId = String(
      sqlite.prepare("SELECT wine_vintage_id FROM bottles LIMIT 1").get()?.["wine_vintage_id"],
    );
    assert.notEqual(importedId, "winner");
    assertCommittedImport(sqlite, importedId);
  });

  await it("resumes an automatic claim after a concurrent winery natural-key conflict", async () => {
    const sqlite = setup();
    sqlite.exec("DELETE FROM wineries");
    insertCapture(sqlite, "extracting");
    const { d1, batchCount } = interleavedDatabase(sqlite, (attempt) => {
      if (attempt === 1) insertWinningWinery(sqlite, "winning-winery");
    });
    const imported = await importBottleCandidate({
      ...automaticImportInput(d1),
      candidate: regionalCandidate(),
    });
    assert.equal(imported.kind, "imported");
    assert.equal(batchCount(), 2);
    const importedId = String(
      sqlite.prepare("SELECT wine_vintage_id FROM bottles LIMIT 1").get()?.["wine_vintage_id"],
    );
    assertCommittedImport(sqlite, importedId);
    assert.equal(
      sqlite.prepare("SELECT winery_id FROM wine_vintages").get()?.["winery_id"],
      "winning-winery",
    );
  });

  await it("keeps extraction reviewable after repeated winery conflicts and allows manual retry", async () => {
    const sqlite = setup();
    sqlite.exec("DELETE FROM wineries");
    insertCapture(sqlite, "needs_review");
    sqlite
      .prepare("UPDATE bottle_capture_runs SET import_candidate_json = ?")
      .run(JSON.stringify(regionalCandidate()));
    const { d1, batchCount } = interleavedDatabase(sqlite, (attempt) => {
      sqlite.exec("DELETE FROM wineries");
      insertWinningWinery(sqlite, `winner-${attempt}`);
    });
    const response = await request(d1, "/bottle-captures/capture/import", {});
    assert.equal(response.status, 409, await response.clone().text());
    assert.equal(batchCount(), 2);
    assert.equal(
      sqlite.prepare("SELECT status FROM bottle_captures").get()?.["status"],
      "needs_review",
    );
    assert.equal(
      sqlite.prepare("SELECT status FROM bottle_capture_runs").get()?.["status"],
      "needs_review",
    );
    assert.equal(
      sqlite.prepare("SELECT import_result_json FROM bottle_capture_runs").get()?.[
        "import_result_json"
      ],
      null,
    );
    assert.equal(
      sqlite.prepare("SELECT import_candidate_json FROM bottle_capture_runs").get()?.[
        "import_candidate_json"
      ],
      JSON.stringify(regionalCandidate()),
    );
    assert.equal(sqlite.prepare("SELECT count(*) AS count FROM bottles").get()?.["count"], 0);
    const retried = await request(asD1(sqlite), "/bottle-captures/capture/import", {});
    assert.equal(retried.status, 200, await retried.clone().text());
    const importedId = String(
      sqlite.prepare("SELECT wine_vintage_id FROM bottles LIMIT 1").get()?.["wine_vintage_id"],
    );
    assertCommittedImport(sqlite, importedId);
    assert.equal(
      sqlite.prepare("SELECT winery_id FROM wine_vintages").get()?.["winery_id"],
      "winner-2",
    );
  });

  await it("does not retry an uncertain commit and replays its persisted import receipt", async () => {
    const sqlite = setup();
    insertCapture(sqlite, "extracting");
    const d1 = asD1(sqlite);
    const batch = d1.batch.bind(d1);
    let batchCount = 0;
    d1.batch = async (statements) => {
      batchCount += 1;
      await batch(statements);
      throw new Error("Response lost after commit");
    };
    const input = automaticImportInput(d1);
    await assert.rejects(importBottleCandidate(input), /Response lost after commit/u);
    assert.equal(batchCount, 1);
    const replayed = await importBottleCandidate(input);
    assert.equal(replayed.kind, "imported");
    assert.equal(batchCount, 1);
    assert.equal(sqlite.prepare("SELECT count(*) AS count FROM bottles").get()?.["count"], 2);
  });

  await it("does not treat unrelated constraints or error text containing a query as retryable", async () => {
    for (const message of [
      "UNIQUE constraint failed: bottles.id",
      "FOREIGN KEY constraint failed",
      "Response lost after commit",
      "Failed query: UNIQUE constraint failed: wine_vintages.site_id, wine_vintages.winery_id, wine_vintages.base_name, wine_vintages.vintage_label",
      ...["CHECK", "FOREIGNKEY", "PRIMARYKEY", "UNKNOWN"].map(
        (constraint) =>
          `D1_ERROR: UNIQUE constraint failed: review_sources.site_id, review_sources.name: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_${constraint})`,
      ),
    ]) {
      let attempts = 0;
      const failure = new Error(message);
      await assert.rejects(
        retryCatalogueTransaction(async () => {
          attempts += 1;
          throw failure;
        }),
        (error: unknown) => error === failure,
      );
      assert.equal(attempts, 1, message);
    }
  });

  await it("recognizes the D1 error wrapper while rebuilding only once", async () => {
    const constraint = "UNIQUE constraint failed: wineries.site_id, wineries.name, wineries.region";
    for (const message of [
      `D1_ERROR: ${constraint}`,
      `D1_ERROR: ${constraint}: SQLITE_CONSTRAINT`,
      "D1_ERROR: UNIQUE constraint failed: review_sources.site_id, review_sources.name: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)",
      "UNIQUE constraint failed: review_sources.site_id, review_sources.name: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)",
    ]) {
      let attempts = 0;
      const result = await retryCatalogueTransaction(async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("Failed query", { cause: new Error(message) });
        return "committed";
      });
      assert.equal(result, "committed");
      assert.equal(attempts, 2);
    }
  });
});

function setup(): DatabaseSync {
  const sqlite = migratedDatabase();
  const userId = userIdForClerkUser("dev:tester");
  sqlite.prepare("INSERT INTO users (id, clerk_user_id) VALUES (?, 'dev:tester')").run(userId);
  sqlite.exec("INSERT INTO sites (id, name) VALUES ('site', 'Cellar')");
  sqlite
    .prepare("INSERT INTO site_memberships (site_id, user_id, role) VALUES ('site', ?, 'owner')")
    .run(userId);
  sqlite.exec(`INSERT INTO wineries (id, site_id, name) VALUES ('winery', 'site', 'Producer');
    INSERT INTO storage_locations (id, site_id, name) VALUES ('location', 'site', 'Rack');
    INSERT INTO review_sources (id, site_id, name) VALUES ('source', 'site', 'Critic');`);
  return sqlite;
}

function insertCapture(sqlite: DatabaseSync, status: string): void {
  sqlite
    .prepare(`INSERT INTO bottle_captures (id, site_id, user_id, status, workflow_instance_id, quantity)
    VALUES ('capture', 'site', ?, ?, 'workflow', 2)`)
    .run(userIdForClerkUser("dev:tester"), status);
  sqlite
    .prepare(`INSERT INTO bottle_capture_runs (id, capture_id, status, import_candidate_json, extractor_version, prompt_version, schema_version)
    VALUES ('run', 'capture', ?, ?, 'v1', 'v1', 'v1')`)
    .run(status, JSON.stringify(candidate));
}

function regionalCandidate() {
  return { ...candidate, wine: { ...wine, region: "Region" } };
}

function insertWinningWinery(sqlite: DatabaseSync, id: string): void {
  sqlite
    .prepare(
      "INSERT INTO wineries (id, site_id, name, region) VALUES (?, 'site', 'Producer', 'Region')",
    )
    .run(id);
}

function insertWinningVintage(sqlite: DatabaseSync, id: string): void {
  sqlite
    .prepare(`INSERT INTO wine_vintages (id, site_id, winery_id, base_name, display_name, vintage_label, vintage_year, notes)
    VALUES (?, 'site', 'winery', 'Reserve', 'Reserve', '2020', 2020, 'Existing notes')`)
    .run(id);
}

function interleavedDatabase(sqlite: DatabaseSync, beforeBatch: (attempt: number) => void) {
  const d1 = asD1(sqlite);
  const batch = d1.batch.bind(d1);
  let count = 0;
  d1.batch = async (statements) => {
    count += 1;
    beforeBatch(count);
    return batch(statements);
  };
  return { d1, batchCount: () => count };
}

async function request(database: D1Database, path: string, payload: Record<string, unknown>) {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The exercised handlers use only D1 and local test authentication.
  const bindings = { DB: database } as Bindings;
  return app.request(
    `http://localhost${path}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-dev-user": "tester" },
      body: JSON.stringify({
        ...(path === "/bottles" ? { operationId: crypto.randomUUID() } : {}),
        ...payload,
      }),
    },
    bindings,
  );
}

function automaticImportInput(database: D1Database) {
  return {
    candidate,
    captureId: "capture",
    database: createD1Client(database),
    quantity: 2,
    siteId: "site",
    storageLocationId: null,
    positionHint: null,
    runId: "run",
    workflowInstanceId: "workflow",
  };
}

function assertCommittedImport(sqlite: DatabaseSync, wineVintageId: string): void {
  assert.equal(sqlite.prepare("SELECT status FROM bottle_captures").get()?.["status"], "imported");
  const run = sqlite.prepare("SELECT status, import_result_json FROM bottle_capture_runs").get();
  assert.equal(run?.["status"], "imported");
  const receipt: unknown = JSON.parse(String(run?.["import_result_json"]));
  assert.ok(
    typeof receipt === "object" &&
      receipt !== null &&
      "wineVintageId" in receipt &&
      "bottleIds" in receipt,
  );
  assert.equal(receipt.wineVintageId, wineVintageId);
  assert.deepEqual(receipt.bottleIds, ["bottle_capture-0", "bottle_capture-1"]);
  assert.deepEqual(
    sqlite
      .prepare("SELECT DISTINCT wine_vintage_id FROM bottles")
      .all()
      .map((row) => row["wine_vintage_id"]),
    [wineVintageId],
  );
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM bottles").get()?.["count"], 2);
}
