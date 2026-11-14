import { createBottleCapture } from "./capture-intake.ts";
// oxlint-disable import/max-dependencies -- Exercises capture lifecycle races across HTTP, Workflow claims, and D1 transactions.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DatabaseSync } from "node:sqlite";

import { createD1Client } from "@chikachow/booze-db";
import { Hono } from "hono";

import { problemResponseForError } from "./api/http.ts";
import { userIdForClerkUser } from "./api/ids.ts";
import type { Bindings } from "./api/types.ts";
import { importBottleCandidate, importReviewedCapture } from "./bottle-importer.ts";
import {
  beginCaptureWorkflow,
  reserveCaptureRetry,
  saveCaptureReview,
  updateCaptureStatus,
} from "./capture-store.ts";
import { asD1, migratedDatabase } from "./d1-support.ts";
import { multipartBucket } from "./multipart-support.ts";
import { bottleCaptureRoutes } from "./routes/bottle-captures.ts";

const candidate = {
  wine: { wineryName: "Producer", designation: "Reserve" },
  bottle: {},
  rawSuggestion: {},
};
const app = new Hono<{ Bindings: Bindings }>()
  .route("/", bottleCaptureRoutes)
  .onError(problemResponseForError);

await describe("capture lifecycle recovery", async () => {
  await it("persists the initial Workflow owner before storing capture images", async () => {
    const sqlite = setup();
    let storedImages = 0;
    const { bucket } = multipartBucket({
      beforePart() {
        const capture = sqlite
          .prepare("SELECT id, workflow_instance_id FROM bottle_captures")
          .get();
        assert.ok(capture);
        assert.equal(capture["workflow_instance_id"], capture["id"]);
        storedImages += 1;
      },
    });
    const capture = await createBottleCapture({
      bucket,
      operationId: crypto.randomUUID(),
      database: createD1Client(asD1(sqlite)),
      files: [new File(["photo"], "label.jpg", { type: "image/jpeg" })],
      positionHint: null,
      quantity: 1,
      siteId: "site",
      storageLocationId: null,
      userId: userIdForClerkUser("dev:tester"),
    });
    assert.equal(capture.status, "queued");
    assert.equal(storedImages, 1);
    assert.equal(
      sqlite.prepare("SELECT workflow_instance_id FROM bottle_captures").get()?.[
        "workflow_instance_id"
      ],
      capture.captureId,
    );
  });

  await it("retains photos and offers retry or deletion after an initial launch failure", async () => {
    for (const action of ["retry", "delete"]) {
      const sqlite = setup();
      let launchAttempts = 0;
      const { response, bindings, objects } = await uploadCapture(sqlite, async () => {
        launchAttempts += 1;
        if (launchAttempts === 1) throw new Error("Workflow service unavailable");
      });
      assert.equal(response.status, 201);
      const capture = sqlite
        .prepare("SELECT id, status, workflow_instance_id FROM bottle_captures")
        .get();
      assert.ok(capture);
      const captureId = capture?.["id"];
      assert.ok(typeof captureId === "string");
      assert.equal(capture["status"], "failed");
      assert.equal(capture["workflow_instance_id"], captureId);
      assert.deepEqual(await response.json(), {
        data: {
          captureId,
          workflowInstanceId: null,
          intakeComplete: true,
          errorMessage:
            "Capture was saved, but extraction startup could not be confirmed. Refresh capture status before retrying.",
        },
      });
      const image = sqlite.prepare("SELECT image_asset_id FROM bottle_capture_images").get();
      assert.ok(typeof image?.["image_asset_id"] === "string");
      const original = await app.request(
        `http://localhost/bottle-captures/${captureId}/images/${image["image_asset_id"]}?original=1`,
        { headers: { "x-dev-user": "tester" } },
        bindings,
      );
      assert.equal(original.status, 200);
      assert.equal(await original.text(), "photo");
      const next = await app.request(
        `http://localhost/bottle-captures/${captureId}${action === "retry" ? "/retry" : ""}`,
        { method: action === "retry" ? "POST" : "DELETE", headers: { "x-dev-user": "tester" } },
        bindings,
      );
      assert.equal(next.status, action === "retry" ? 200 : 204);
      assert.equal(objects.size, action === "retry" ? 1 : 0);
      assert.equal(launchAttempts, action === "retry" ? 2 : 1);
      assert.equal(captureStatus(sqlite), action === "retry" ? "queued" : undefined);
    }
  });

  await it("preserves started processing after a lost initial launch acknowledgement", async () => {
    for (const status of ["extracting", "importing", "needs_review", "imported"]) {
      const sqlite = setup();
      const { response, objects } = await uploadCapture(sqlite, async (id) => {
        const database = createD1Client(asD1(sqlite));
        assert.equal(
          await beginCaptureWorkflow({ captureId: id, database, workflowInstanceId: id }),
          true,
        );
        sqlite.prepare("UPDATE bottle_captures SET status = ? WHERE id = ?").run(status, id);
        throw new Error("Workflow launch response lost");
      });
      assert.equal(response.status, 201);
      assert.equal(captureStatus(sqlite), status);
      assert.equal(objects.size, 1);
      assert.equal(
        sqlite.prepare("SELECT error_message FROM bottle_captures").get()?.["error_message"],
        null,
      );
    }
  });

  await it("replays a manually imported capture after a lost HTTP acknowledgement", async () => {
    const sqlite = setup("needs_review");
    const d1 = asD1(sqlite);
    const first = await request(d1, "/bottle-captures/capture/import");
    assert.equal(first.status, 200);
    const committed: unknown = await first.json();
    const replay = await request(d1, "/bottle-captures/capture/import");
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), committed);
    assert.equal(sqlite.prepare("SELECT count(*) AS count FROM bottles").get()?.["count"], 2);
    assert.equal(captureStatus(sqlite), "imported");
  });

  await it("replays only the receipt without parsing old candidates or applying new choices", async () => {
    const sqlite = setup("needs_review");
    const d1 = asD1(sqlite);
    const first = await request(d1, "/bottle-captures/capture/import");
    assert.equal(first.status, 200);
    const committed: unknown = await first.json();
    sqlite.exec("UPDATE bottle_capture_runs SET import_candidate_json = '{}' WHERE id = 'run'");
    const replay = await request(d1, "/bottle-captures/capture/import", undefined, {
      wineVintageId: "a-different-choice",
    });
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), committed);
    assert.equal(sqlite.prepare("SELECT count(*) AS count FROM bottles").get()?.["count"], 2);
  });

  await it("retains write authorization and requires a receipt for completed imports", async () => {
    const sqlite = setup("needs_review");
    const d1 = asD1(sqlite);
    assert.equal((await request(d1, "/bottle-captures/capture/import")).status, 200);
    sqlite.exec("UPDATE site_memberships SET role = 'viewer'");
    assert.equal((await request(d1, "/bottle-captures/capture/import")).status, 403);
    sqlite.exec("UPDATE site_memberships SET role = 'owner'");
    sqlite.exec("UPDATE bottle_capture_runs SET import_result_json = NULL WHERE id = 'run'");
    assert.equal((await request(d1, "/bottle-captures/capture/import")).status, 409);
    assert.equal(sqlite.prepare("SELECT count(*) AS count FROM bottles").get()?.["count"], 2);
  });

  await it("restarts only unfinished captures owned by the same Workflow", async () => {
    for (const status of ["queued", "extracting", "importing", "failed", "needs_review"]) {
      const sqlite = setup(status);
      const database = createD1Client(asD1(sqlite));
      assert.equal(
        await beginCaptureWorkflow({ captureId: "capture", database, workflowInstanceId: "old" }),
        false,
        `stale Workflow in ${status}`,
      );
      assert.equal(
        await beginCaptureWorkflow({
          captureId: "capture",
          database,
          workflowInstanceId: "workflow",
        }),
        true,
        `current Workflow in ${status}`,
      );
      assert.equal(captureStatus(sqlite), "extracting");
    }
    for (const status of ["imported", "upload_failed"]) {
      const sqlite = setup(status);
      assert.equal(
        await beginCaptureWorkflow({
          captureId: "capture",
          database: createD1Client(asD1(sqlite)),
          workflowInstanceId: "workflow",
        }),
        false,
      );
      assert.equal(captureStatus(sqlite), status);
    }
  });

  await it("preserves started extraction after a lost retry-launch acknowledgement", async () => {
    for (const status of ["extracting", "importing", "needs_review", "imported"]) {
      const sqlite = setup("failed");
      const d1 = asD1(sqlite);
      const response = await request(d1, "/bottle-captures/capture/retry", {
        async create() {
          sqlite.prepare("UPDATE bottle_captures SET status = ?").run(status);
          throw new Error("Workflow launch response lost");
        },
      });
      assert.equal(response.status, 503);
      assert.equal(captureStatus(sqlite), status);
      assert.equal(
        await reserveCaptureRetry({
          captureId: "capture",
          database: createD1Client(d1),
          workflowInstanceId: "another-retry",
        }),
        status === "needs_review",
      );
    }
  });

  await it("makes a launch failure retryable while its capture is still queued", async () => {
    const sqlite = setup("failed");
    const d1 = asD1(sqlite);
    const response = await request(d1, "/bottle-captures/capture/retry", {
      async create() {
        throw new Error("Workflow service unavailable");
      },
    });
    assert.equal(response.status, 503);
    assert.equal(captureStatus(sqlite), "failed");
    assert.equal(
      await reserveCaptureRetry({
        captureId: "capture",
        database: createD1Client(d1),
        workflowInstanceId: "another-retry",
      }),
      true,
    );
  });

  await it("rolls back an old owner's entire import when a new Workflow owns the capture", async () => {
    const sqlite = setup("extracting");
    const d1 = beforeFirstBatch(sqlite, () => {
      sqlite.exec("UPDATE bottle_captures SET status = 'queued', workflow_instance_id = 'new'");
    });
    const imported = await importBottleCandidate(automaticInput(d1));
    assert.equal(imported.kind, "skipped");
    assert.equal(captureStatus(sqlite), "queued");
    assert.equal(
      sqlite.prepare("SELECT workflow_instance_id FROM bottle_captures").get()?.[
        "workflow_instance_id"
      ],
      "new",
    );
    assertNoImport(sqlite);
  });

  await it("checks the guard's NOT NULL constraint before ignoring an existing run ID", async () => {
    for (const stale of [false, true]) {
      const sqlite = setup("extracting");
      const d1 = asD1(sqlite);
      const batch = d1.batch.bind(d1);
      let batchError: unknown;
      d1.batch = async (statements) => {
        if (stale) sqlite.exec("UPDATE bottle_captures SET workflow_instance_id = 'new'");
        try {
          return await batch(statements);
        } catch (error) {
          batchError = error;
          throw error;
        }
      };
      assert.equal(
        (await importBottleCandidate(automaticInput(d1))).kind,
        stale ? "skipped" : "imported",
      );
      if (stale) {
        assert.ok(batchError instanceof Error);
        assert.equal(
          batchError.message,
          "NOT NULL constraint failed: bottle_capture_runs.capture_id",
        );
        assertNoImport(sqlite);
      } else {
        assert.equal(batchError, undefined);
      }
      assert.deepEqual(
        {
          ...sqlite
            .prepare(
              "SELECT extractor_version, prompt_version, schema_version FROM bottle_capture_runs",
            )
            .get(),
        },
        { extractor_version: "v1", prompt_version: "v1", schema_version: "v1" },
      );
      assert.equal(
        sqlite.prepare("SELECT count(*) AS count FROM bottle_capture_runs").get()?.["count"],
        1,
      );
    }
  });

  await it("does not commit a claimed run after a newer run replaces it", async () => {
    const sqlite = setup("extracting");
    const d1 = beforeFirstBatch(sqlite, () => {
      sqlite.exec(`INSERT INTO bottle_capture_runs
        (id, capture_id, status, extractor_version, prompt_version, schema_version, attempt_number)
        VALUES ('new-run', 'capture', 'extracting', 'v2', 'v2', 'v2', 2)`);
    });
    assert.equal((await importBottleCandidate(automaticInput(d1))).kind, "skipped");
    assertNoImport(sqlite);
  });

  await it("does not create inventory after its capture and receipt were deleted before commit", async () => {
    const sqlite = setup("extracting");
    const d1 = beforeFirstBatch(sqlite, () => {
      sqlite.exec("DELETE FROM bottle_capture_runs; DELETE FROM bottle_captures");
    });
    assert.equal((await importBottleCandidate(automaticInput(d1))).kind, "skipped");
    assertNoImport(sqlite);
  });

  await it("returns a manual import conflict without downgrading a newer owner", async () => {
    const sqlite = setup("needs_review");
    const d1 = beforeFirstBatch(sqlite, () => {
      sqlite.exec("UPDATE bottle_captures SET status = 'queued', workflow_instance_id = 'new'");
    });
    const response = await request(d1, "/bottle-captures/capture/import");
    assert.equal(response.status, 409, await response.clone().text());
    assert.equal(captureStatus(sqlite), "queued");
    assertNoImport(sqlite);
  });

  await it("keeps manual preparation reviewable if execution stops before the batch", async () => {
    const sqlite = setup("needs_review");
    const d1 = asD1(sqlite);
    const interrupted = new Error("Execution stopped before import batch");
    d1.batch = async () => {
      assert.equal(captureStatus(sqlite), "needs_review");
      throw interrupted;
    };
    await assert.rejects(
      importReviewedCapture({ ...automaticInput(d1), expectedReviewRevision: 0 }),
      (error: unknown) => error === interrupted,
    );
    assert.equal(captureStatus(sqlite), "needs_review");
    assertNoImport(sqlite);
  });

  await it("retains a manual candidate after a proven transaction rollback and supports retry", async () => {
    const sqlite = setup("needs_review");
    sqlite.exec(`CREATE TRIGGER fail_bottle BEFORE INSERT ON bottles
      BEGIN SELECT RAISE(ABORT, 'injected bottle failure'); END`);
    const d1 = asD1(sqlite);
    assert.equal((await request(d1, "/bottle-captures/capture/import")).status, 500);
    assert.equal(captureStatus(sqlite), "needs_review");
    assert.equal(
      sqlite.prepare("SELECT status FROM bottle_capture_runs").get()?.["status"],
      "needs_review",
    );
    assertNoImport(sqlite);
    sqlite.exec("DROP TRIGGER fail_bottle");
    assert.equal((await request(d1, "/bottle-captures/capture/import")).status, 200);
  });

  await it("aborts the entire manual import if saved corrections change during preparation", async () => {
    const sqlite = setup("needs_review");
    const reviewed = JSON.stringify({ ...candidate, bottle: { notes: "New correction" } });
    const d1 = beforeFirstBatch(sqlite, () => {
      sqlite
        .prepare("UPDATE bottle_captures SET review_revision = 1, review_candidate_json = ?")
        .run(reviewed);
    });
    const response = await request(d1, "/bottle-captures/capture/import");
    assert.equal(response.status, 409, await response.clone().text());
    assert.equal(captureStatus(sqlite), "needs_review");
    assert.equal(
      sqlite.prepare("SELECT review_candidate_json FROM bottle_captures").get()?.[
        "review_candidate_json"
      ],
      reviewed,
    );
    assertNoImport(sqlite);
  });

  await it("allows saving corrections during manual preparation and rejects the stale import", async () => {
    const sqlite = setup("needs_review");
    const d1 = asD1(sqlite);
    const batch = d1.batch.bind(d1);
    let correctionsSaved = false;
    d1.batch = async (statements) => {
      assert.equal(
        await saveCaptureReview({
          captureId: "capture",
          database: createD1Client(asD1(sqlite)),
          expectedRevision: 0,
          candidate: {
            wine: { wineryName: "Corrected Producer", designation: "Reserve" },
            bottle: {},
          },
        }),
        1,
      );
      correctionsSaved = true;
      return batch(statements);
    };
    const response = await request(d1, "/bottle-captures/capture/import");
    assert.equal(response.status, 409, await response.clone().text());
    assert.equal(correctionsSaved, true);
    assert.equal(captureStatus(sqlite), "needs_review");
    assertNoImport(sqlite);
  });

  await it("aborts manual import after a newer run or deletion during preparation", async () => {
    for (const change of ["run", "delete"]) {
      const sqlite = setup("needs_review");
      const d1 = beforeFirstBatch(sqlite, () => {
        if (change === "run") {
          sqlite.exec(`INSERT INTO bottle_capture_runs
            (id, capture_id, status, extractor_version, prompt_version, schema_version, attempt_number)
            VALUES ('new-run', 'capture', 'needs_review', 'v2', 'v2', 'v2', 2)`);
        } else {
          sqlite.exec("DELETE FROM bottle_capture_runs; DELETE FROM bottle_captures");
        }
      });
      assert.equal((await request(d1, "/bottle-captures/capture/import")).status, 409);
      assert.equal(captureStatus(sqlite), change === "run" ? "needs_review" : undefined);
      assertNoImport(sqlite);
    }
  });

  await it("returns one receipt and one inventory effect for two manual imports", async () => {
    const sqlite = setup("needs_review");
    const d1 = asD1(sqlite);
    const responses = await Promise.all([
      request(d1, "/bottle-captures/capture/import"),
      request(d1, "/bottle-captures/capture/import"),
    ]);
    assert.deepEqual(
      responses.map((response) => response.status),
      [200, 200],
    );
    assert.deepEqual(await responses[0]?.json(), await responses[1]?.json());
    assert.equal(sqlite.prepare("SELECT count(*) AS count FROM bottles").get()?.["count"], 2);
    assert.equal(sqlite.prepare("SELECT count(*) AS count FROM wine_vintages").get()?.["count"], 1);
  });

  await it("uses the current capture destination when a location is deleted during preparation", async () => {
    const sqlite = setup("needs_review");
    sqlite.exec(`INSERT INTO storage_locations (id, site_id, name) VALUES ('location', 'site', 'Rack');
      UPDATE bottle_captures SET storage_location_id = 'location', position_hint = 'A1'`);
    const d1 = beforeFirstBatch(sqlite, () => {
      sqlite.exec(`UPDATE bottle_captures SET storage_location_id = NULL;
        DELETE FROM storage_locations WHERE id = 'location'`);
    });
    const response = await request(d1, "/bottle-captures/capture/import");
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(sqlite.prepare("SELECT count(*) AS count FROM bottles").get()?.["count"], 2);
    assert.equal(
      sqlite.prepare("SELECT count(*) AS count FROM bottle_locations").get()?.["count"],
      0,
    );
  });

  await it("atomically rejects a selected wine moved outside the capture site during preparation", async () => {
    const sqlite = setup("needs_review");
    sqlite.exec(`INSERT INTO sites (id, name) VALUES ('other', 'Other');
      INSERT INTO wine_vintages (id, site_id, base_name, display_name, vintage_label) VALUES ('vintage', 'site', 'Wine', 'Wine', 'NV')`);
    const d1 = beforeFirstBatch(sqlite, () => {
      sqlite.exec("UPDATE wine_vintages SET site_id = 'other' WHERE id = 'vintage'");
    });
    const response = await request(d1, "/bottle-captures/capture/import", undefined, {
      wineVintageId: "vintage",
    });
    assert.equal(response.status, 409, await response.clone().text());
    assert.equal(captureStatus(sqlite), "needs_review");
    assert.equal(sqlite.prepare("SELECT count(*) AS count FROM bottles").get()?.["count"], 0);
    assert.equal(
      sqlite.prepare("SELECT import_result_json FROM bottle_capture_runs").get()?.[
        "import_result_json"
      ],
      null,
    );
  });

  await it("returns the durable manual receipt after a lost commit acknowledgement", async () => {
    const sqlite = setup("needs_review");
    const d1 = asD1(sqlite);
    const batch = d1.batch.bind(d1);
    let writes = 0;
    d1.batch = async (statements) => {
      writes += 1;
      await batch(statements);
      throw new Error("Manual import commit acknowledgement lost");
    };
    const response = await request(d1, "/bottle-captures/capture/import");
    assert.equal(response.status, 200, await response.clone().text());
    const replay = await request(d1, "/bottle-captures/capture/import");
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), await response.json());
    assert.equal(writes, 1);
    assert.equal(captureStatus(sqlite), "imported");
    assert.equal(
      sqlite.prepare("SELECT status FROM bottle_capture_runs").get()?.["status"],
      "imported",
    );
    assert.equal(sqlite.prepare("SELECT count(*) AS count FROM bottles").get()?.["count"], 2);
  });

  await it("preserves historical manual importing rows without guessing recovery", async () => {
    const sqlite = setup("importing");
    assert.equal((await request(asD1(sqlite), "/bottle-captures/capture/import")).status, 409);
    assert.equal(captureStatus(sqlite), "importing");
    assertNoImport(sqlite);
  });

  await it("keeps an invalid candidate reviewable and lets the user select an existing wine", async () => {
    const sqlite = setup("needs_review");
    const invalidCandidate = {
      ...candidate,
      wine: { ...candidate.wine, drinkFromYear: 2030, drinkToYear: 2020 },
    };
    sqlite
      .prepare(
        "UPDATE bottle_capture_runs SET import_candidate_json = ?, extraction_r2_key = 'evidence.json'",
      )
      .run(JSON.stringify(invalidCandidate));
    const response = await request(asD1(sqlite), "/bottle-captures/capture/import");
    assert.equal(response.status, 400, await response.clone().text());
    assert.equal(captureStatus(sqlite), "needs_review");
    assert.deepEqual(
      {
        ...sqlite
          .prepare(
            "SELECT status, import_candidate_json, extraction_r2_key FROM bottle_capture_runs",
          )
          .get(),
      },
      {
        status: "needs_review",
        import_candidate_json: JSON.stringify(invalidCandidate),
        extraction_r2_key: "evidence.json",
      },
    );
    assertNoImport(sqlite);
    sqlite.exec(`INSERT INTO wineries (id, site_id, name) VALUES ('winery', 'site', 'Producer');
      INSERT INTO wine_vintages (id, site_id, winery_id, base_name, display_name, vintage_label)
      VALUES ('vintage', 'site', 'winery', 'Reserve', 'Reserve', 'NV')`);
    const retried = await request(asD1(sqlite), "/bottle-captures/capture/import", undefined, {
      wineVintageId: "vintage",
    });
    assert.equal(retried.status, 200, await retried.clone().text());
    assert.equal(captureStatus(sqlite), "imported");
    assert.equal(sqlite.prepare("SELECT count(*) AS count FROM bottles").get()?.["count"], 2);
  });

  await it("does not disguise unrelated transaction failures as lost ownership", async () => {
    for (const message of [
      "NOT NULL constraint failed: bottles.wine_vintage_id",
      "FOREIGN KEY constraint failed",
      "Failed query: NOT NULL constraint failed: bottle_capture_runs.capture_id",
    ]) {
      const sqlite = setup("extracting");
      const d1 = asD1(sqlite);
      const failure = new Error(message);
      d1.batch = async () => {
        throw failure;
      };
      await assert.rejects(
        importBottleCandidate(automaticInput(d1)),
        (error: unknown) => error === failure,
      );
      assertNoImport(sqlite);
    }
  });

  await it("recognizes the native D1 NOT NULL guard error and its extended result code", async () => {
    const sqlite = setup("extracting");
    const d1 = asD1(sqlite);
    d1.batch = async () => {
      sqlite.exec("UPDATE bottle_captures SET workflow_instance_id = 'new'");
      throw new Error("Failed query", {
        cause: new Error(
          "D1_ERROR: NOT NULL constraint failed: bottle_capture_runs.capture_id: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_NOTNULL)",
        ),
      });
    };
    assert.equal((await importBottleCandidate(automaticInput(d1))).kind, "skipped");
    assertNoImport(sqlite);
  });

  await it("replays a committed receipt after losing its acknowledgement without a second write", async () => {
    const sqlite = setup("extracting");
    const d1 = asD1(sqlite);
    const batch = d1.batch.bind(d1);
    let writes = 0;
    d1.batch = async (statements) => {
      writes += 1;
      await batch(statements);
      throw new Error("Import response lost after commit");
    };
    const input = automaticInput(d1);
    await assert.rejects(importBottleCandidate(input), /Import response lost after commit/u);
    await updateCaptureStatus({
      captureId: "capture",
      database: input.database,
      status: "failed",
      workflowInstanceId: "workflow",
    });
    const replayed = await importBottleCandidate(input);
    assert.equal(replayed.kind, "imported");
    assert.equal(writes, 1);
    assert.equal(captureStatus(sqlite), "imported");
    assert.equal(sqlite.prepare("SELECT count(*) AS count FROM bottles").get()?.["count"], 2);
    assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
  });
});

function setup(status?: string): DatabaseSync {
  const sqlite = migratedDatabase();
  const userId = userIdForClerkUser("dev:tester");
  sqlite.prepare("INSERT INTO users (id, clerk_user_id) VALUES (?, 'dev:tester')").run(userId);
  sqlite.exec("INSERT INTO sites (id, name) VALUES ('site', 'Cellar')");
  sqlite
    .prepare("INSERT INTO site_memberships (site_id, user_id, role) VALUES ('site', ?, 'owner')")
    .run(userId);
  if (status === undefined) return sqlite;
  sqlite
    .prepare(`INSERT INTO bottle_captures (id, site_id, user_id, status, workflow_instance_id, quantity)
    VALUES ('capture', 'site', ?, ?, 'workflow', 2)`)
    .run(userId, status);
  sqlite
    .prepare(`INSERT INTO bottle_capture_runs (id, capture_id, status, import_candidate_json, extractor_version, prompt_version, schema_version)
    VALUES ('run', 'capture', ?, ?, 'v1', 'v1', 'v1')`)
    .run(status, JSON.stringify(candidate));
  return sqlite;
}

function beforeFirstBatch(sqlite: DatabaseSync, interleave: () => void): D1Database {
  const d1 = asD1(sqlite);
  const batch = d1.batch.bind(d1);
  let first = true;
  d1.batch = async (statements) => {
    if (first) {
      first = false;
      interleave();
    }
    return batch(statements);
  };
  return d1;
}

function automaticInput(d1: D1Database) {
  return {
    candidate,
    captureId: "capture",
    database: createD1Client(d1),
    quantity: 2,
    siteId: "site",
    storageLocationId: null,
    positionHint: null,
    runId: "run",
    workflowInstanceId: "workflow",
  };
}

function captureStatus(sqlite: DatabaseSync): unknown {
  return sqlite.prepare("SELECT status FROM bottle_captures").get()?.["status"];
}

function assertNoImport(sqlite: DatabaseSync): void {
  for (const table of ["wineries", "wine_vintages", "bottles", "bottle_locations"]) {
    assert.equal(sqlite.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.["count"], 0);
  }
  assert.equal(
    sqlite
      .prepare(
        "SELECT count(*) AS count FROM bottle_capture_runs WHERE import_result_json IS NOT NULL",
      )
      .get()?.["count"],
    0,
  );
  assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
}

async function request(
  d1: D1Database,
  path: string,
  workflow?: Pick<Workflow, "create">,
  payload: Readonly<Record<string, unknown>> = {},
): Promise<Response> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Test handlers use only D1, local authentication, and the supplied failing Workflow binding.
  const bindings = { DB: d1, BOTTLE_CAPTURE_WORKFLOW: workflow } as Bindings;
  return app.request(
    `http://localhost${path}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-dev-user": "tester" },
      body: JSON.stringify(payload),
    },
    bindings,
  );
}

async function uploadCapture(sqlite: DatabaseSync, start: (id: string) => Promise<void>) {
  const { bucket, objects } = multipartBucket();
  // oxlint-disable typescript/no-unsafe-type-assertion -- These external bindings implement the capture and Workflow operations exercised by the routes.
  const bindings = {
    DB: asD1(sqlite),
    IMAGE_BUCKET: bucket,
    BOTTLE_CAPTURE_WORKFLOW: {
      async create({ id }: { readonly id: string }) {
        await start(id);
        return { id };
      },
    },
  } as unknown as Bindings;
  // oxlint-enable typescript/no-unsafe-type-assertion
  const body = new FormData();
  body.set("operationId", crypto.randomUUID());
  body.set("siteId", "site");
  body.set("quantity", "1");
  body.set("images", new File(["photo"], "label.jpg", { type: "image/jpeg" }));
  const response = await app.request(
    "http://localhost/bottle-captures",
    { method: "POST", headers: { "x-dev-user": "tester" }, body },
    bindings,
  );
  return { response, bindings, objects };
}
