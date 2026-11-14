import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createD1Client } from "@chikachow/booze-db";

import { importBottleCandidate, matchBottleCandidate } from "./bottle-importer.ts";
import {
  beginCaptureWorkflow,
  claimCaptureForImport,
  createCaptureRun,
  getBottleCapture,
  getCaptureImageObject,
  listBottleCaptures,
  reserveCaptureRetry,
  updateCaptureRun,
  updateCaptureStatus,
} from "./capture-store.ts";
import { deleteBottleCaptureData, drainR2ObjectDeletionQueue } from "./deletion.ts";
import { createBottleCapture } from "./capture-intake.ts";
import { multipartBucket } from "./multipart-support.ts";
import { asD1, migratedDatabase } from "./d1-support.ts";

await describe("capture persistence", async () => {
  await it("rolls back a failed import and resumes it without duplicate bottles", async () => {
    const sqlite = seededDatabase();
    const database = createD1Client(asD1(sqlite));
    sqlite.exec(`
      INSERT INTO storage_locations (id, site_id, name) VALUES ('location', 'site', 'Rack');
      INSERT INTO bottle_captures (id, site_id, user_id, status, storage_location_id)
      VALUES ('capture', 'site', 'user', 'extracting', 'location');
      CREATE TRIGGER fail_location BEFORE INSERT ON bottle_locations
      BEGIN SELECT RAISE(ABORT, 'injected location failure'); END;
    `);
    await createCaptureRun({ captureId: "capture", database, runId: "run", status: "extracting" });
    const input = {
      candidate: {
        wine: { wineryName: "Test Winery", designation: "Reserve" },
        bottle: {},
        rawSuggestion: {},
      },
      captureId: "capture",
      database,
      positionHint: null,
      quantity: 24,
      runId: "run",
      siteId: "site",
      storageLocationId: "location",
    };

    await assert.rejects(importBottleCandidate(input));
    for (const table of ["bottles", "bottle_locations", "wine_vintages", "wineries"]) {
      assert.equal(
        sqlite.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.["count"],
        0,
        table,
      );
    }
    assert.equal(
      sqlite.prepare("SELECT status FROM bottle_captures").get()?.["status"],
      "importing",
    );
    sqlite.exec("DROP TRIGGER fail_location");

    const imported = await importBottleCandidate(input);
    assert.equal(imported.kind, "imported");
    assert.deepEqual(await importBottleCandidate(input), imported);
    assert.equal(sqlite.prepare("SELECT count(*) AS count FROM bottles").get()?.["count"], 24);
    assert.equal(
      sqlite.prepare("SELECT count(*) AS count FROM bottle_locations").get()?.["count"],
      24,
    );
    assert.equal(
      sqlite.prepare("SELECT status FROM bottle_captures").get()?.["status"],
      "imported",
    );

    await updateCaptureStatus({
      captureId: "capture",
      database,
      status: "failed",
      errorMessage: "Late failure",
    });
    await updateCaptureRun({
      database,
      runId: "run",
      status: "failed",
      errorMessage: "Late failure",
    });
    assert.equal(
      sqlite.prepare("SELECT status FROM bottle_captures").get()?.["status"],
      "imported",
    );
    assert.equal(
      sqlite.prepare("SELECT status FROM bottle_capture_runs").get()?.["status"],
      "imported",
    );
    assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
  });

  await it("reserves one retry and rejects stale Workflow claims", async () => {
    const sqlite = seededDatabase();
    sqlite.exec(
      "INSERT INTO bottle_captures (id, site_id, user_id, status) VALUES ('capture', 'site', 'user', 'needs_review')",
    );
    const database = createD1Client(asD1(sqlite));
    assert.equal(
      await reserveCaptureRetry({ captureId: "capture", database, workflowInstanceId: "new" }),
      true,
    );
    assert.equal(
      await reserveCaptureRetry({ captureId: "capture", database, workflowInstanceId: "other" }),
      false,
    );
    assert.equal(
      await beginCaptureWorkflow({ captureId: "capture", database, workflowInstanceId: "old" }),
      false,
    );
    assert.equal(
      await beginCaptureWorkflow({ captureId: "capture", database, workflowInstanceId: "new" }),
      true,
    );
    assert.equal(
      await claimCaptureForImport({
        captureId: "capture",
        database,
        runId: "same-run",
        siteId: "site",
      }),
      null,
    );
    await updateCaptureStatus({
      captureId: "capture",
      database,
      status: "failed",
      workflowInstanceId: "old",
    });
    assert.equal(
      sqlite.prepare("SELECT status FROM bottle_captures").get()?.["status"],
      "extracting",
    );
    await createCaptureRun({
      captureId: "capture",
      database,
      runId: "same-run",
      status: "extracting",
    });
    await createCaptureRun({
      captureId: "capture",
      database,
      runId: "same-run",
      status: "extracting",
    });
    assert.equal(
      sqlite.prepare("SELECT count(*) AS count FROM bottle_capture_runs").get()?.["count"],
      1,
    );
  });

  await it("preserves a re-uploaded photo when an old deletion is retried", async () => {
    const sqlite = seededDatabase();
    const database = createD1Client(asD1(sqlite));
    const { bucket, objects } = multipartBucket();
    const input = {
      bucket,
      database,
      files: [new File(["photo"], "label.jpg", { type: "image/jpeg" })],
      positionHint: null,
      quantity: 1,
      siteId: "site",
      storageLocationId: null,
      userId: "user",
    };
    const first = await createBottleCapture({ ...input, operationId: crypto.randomUUID() });
    await updateCaptureStatus({ captureId: first.captureId, database, status: "failed" });
    const originalKey = String(sqlite.prepare("SELECT r2_key FROM image_assets").get()?.["r2_key"]);
    await deleteBottleCaptureData({ captureId: first.captureId, database: asD1(sqlite) });
    const second = await createBottleCapture({ ...input, operationId: crypto.randomUUID() });
    assert.equal(second.status, "queued");
    const newKey = String(sqlite.prepare("SELECT r2_key FROM image_assets").get()?.["r2_key"]);
    assert.notEqual(newKey, originalKey);
    await drainR2ObjectDeletionQueue({ bucket, database: asD1(sqlite) });
    assert.equal(objects.has(originalKey), false);
    assert.equal(objects.has(newKey), true);
  });

  await it("preserves separate photo lifetimes for simultaneous captures", async () => {
    const sqlite = seededDatabase();
    const database = createD1Client(asD1(sqlite));
    const { bucket, objects } = multipartBucket();
    const input = {
      bucket,
      database,
      files: [new File(["photo"], "label.jpg", { type: "image/jpeg" })],
      positionHint: null,
      quantity: 1,
      siteId: "site",
      storageLocationId: null,
      userId: "user",
    };
    const results = await Promise.all([
      createBottleCapture({ ...input, operationId: crypto.randomUUID() }),
      createBottleCapture({ ...input, operationId: crypto.randomUUID() }),
    ]);
    assert.deepEqual(
      results.map((result) => result.status),
      ["queued", "queued"],
    );
    assert.equal(sqlite.prepare("SELECT count(*) AS count FROM image_assets").get()?.["count"], 2);
    assert.equal(
      sqlite.prepare("SELECT count(*) AS count FROM bottle_capture_images").get()?.["count"],
      2,
    );
    await drainR2ObjectDeletionQueue({ bucket, database: asD1(sqlite) });
    const storedKeys = sqlite
      .prepare("SELECT r2_key FROM image_assets")
      .all()
      .map((row) => String(row["r2_key"]));
    assert.deepEqual([...objects.keys()].toSorted(), storedKeys.toSorted());
  });

  await it("protects live photos referenced by legacy deletion queue entries", async () => {
    const sqlite = seededDatabase();
    const database = createD1Client(asD1(sqlite));
    const { bucket, objects } = multipartBucket();
    await createBottleCapture({
      operationId: crypto.randomUUID(),
      bucket,
      database,
      files: [new File(["photo"], "label.jpg", { type: "image/jpeg" })],
      positionHint: null,
      quantity: 1,
      siteId: "site",
      storageLocationId: null,
      userId: "user",
    });
    const storedKey = String(sqlite.prepare("SELECT r2_key FROM image_assets").get()?.["r2_key"]);
    sqlite
      .prepare(
        "INSERT INTO r2_object_deletion_queue (r2_key, source_kind, source_id) VALUES (?, 'image_asset', 'old-asset')",
      )
      .run(storedKey);
    assert.equal(await drainR2ObjectDeletionQueue({ bucket, database: asD1(sqlite) }), 0);
    assert.equal(objects.has(storedKey), true);
    assert.equal(
      sqlite.prepare("SELECT count(*) AS count FROM r2_object_deletion_queue").get()?.["count"],
      0,
    );
  });

  await it("cannot delete a capture after processing has started", async () => {
    const sqlite = seededDatabase();
    const database = createD1Client(asD1(sqlite));
    const { bucket } = multipartBucket();
    const capture = await createBottleCapture({
      operationId: crypto.randomUUID(),
      bucket,
      database,
      files: [new File(["photo"], "label.jpg", { type: "image/jpeg" })],
      positionHint: null,
      quantity: 1,
      siteId: "site",
      storageLocationId: null,
      userId: "user",
    });
    assert.equal(
      await deleteBottleCaptureData({ captureId: capture.captureId, database: asD1(sqlite) }),
      false,
    );
    assert.equal(
      sqlite.prepare("SELECT count(*) AS count FROM bottle_capture_images").get()?.["count"],
      1,
    );
    assert.equal(
      sqlite.prepare("SELECT count(*) AS count FROM r2_object_deletion_queue").get()?.["count"],
      0,
    );
  });

  await it("bounds capture summaries and hydrates selected detail with authorized image reads", async () => {
    const sqlite = seededDatabase();
    sqlite.exec(`INSERT INTO site_memberships (site_id, user_id, role) VALUES ('site', 'user', 'owner');
      INSERT INTO image_assets (id, site_id, sha256, r2_key, content_type, size_bytes, uploaded_by_user_id)
      VALUES ('image', 'site', 'sha', 'photo.jpg', 'image/jpeg', 1, 'user');`);
    for (let index = 0; index < 100; index += 1) {
      const id = `capture-${index}`;
      sqlite
        .prepare("INSERT INTO bottle_captures (id, site_id, user_id) VALUES (?, 'site', 'user')")
        .run(id);
      sqlite
        .prepare(
          "INSERT INTO bottle_capture_images (capture_id, image_asset_id, sort_order) VALUES (?, 'image', 0)",
        )
        .run(id);
      for (const attempt of [1, 2]) {
        sqlite
          .prepare(`INSERT INTO bottle_capture_runs (id, capture_id, status, extractor_version, prompt_version, schema_version, attempt_number)
          VALUES (?, ?, 'needs_review', 'v1', 'v1', 'v1', ?)`)
          .run(`${id}-${attempt}`, id, attempt);
      }
    }
    const d1 = asD1(sqlite);
    let queries = 0;
    const prepare = d1.prepare.bind(d1);
    d1.prepare = (query: string) => {
      queries += 1;
      return prepare(query);
    };
    const database = createD1Client(d1);
    const captures = await listBottleCaptures({ database, userId: "user" });
    assert.equal(queries, 2);
    assert.equal(captures.data.length, 50);
    assert.equal(captures.totalCount, 100);
    for (const capture of captures.data) {
      assert.equal(capture.imageCount, 1);
      assert.equal(capture.previewImage?.imageAssetId, "image");
      assert.equal("latestRun" in capture, false);
    }
    queries = 0;
    const detail = await getBottleCapture({ captureId: "capture-20", database, userId: "user" });
    assert.equal(detail.id, "capture-20");
    assert.equal(detail.images.length, 1);
    assert.equal(detail.latestRun?.id, "capture-20-2");
    assert.equal(queries, 3);
    queries = 0;
    assert.equal(
      (
        await getCaptureImageObject({
          captureId: "capture-20",
          database,
          imageAssetId: "image",
          userId: "user",
        })
      ).r2Key,
      "photo.jpg",
    );
    assert.equal(queries, 1);
    await assert.rejects(
      getCaptureImageObject({
        captureId: "capture-20",
        database,
        imageAssetId: "image",
        userId: "outsider",
      }),
      /not found/u,
    );
  });

  await it("does not match different non-Latin names or empty normalized identities", async () => {
    const sqlite = seededDatabase();
    sqlite.exec(`INSERT INTO wineries (id, site_id, name) VALUES ('winery', 'site', '甲酒庄');
      INSERT INTO wine_vintages (id, site_id, winery_id, base_name, display_name, vintage_label)
      VALUES ('wine', 'site', 'winery', '珍藏', '珍藏', 'NV');`);
    const database = createD1Client(asD1(sqlite));
    assert.equal(
      (
        await matchBottleCandidate({
          database,
          siteId: "site",
          candidate: {
            wine: { wineryName: "乙酒庄", designation: "珍藏" },
            bottle: {},
            rawSuggestion: {},
          },
        })
      ).kind,
      "create_new",
    );
    assert.equal(
      (
        await matchBottleCandidate({
          database,
          siteId: "site",
          candidate: {
            wine: { wineryName: "Estate", designation: "Reserve" },
            bottle: {},
            rawSuggestion: {},
          },
        })
      ).kind,
      "needs_review",
    );
  });

  await it("preserves legacy partial bottles when a retry proposes a different wine", async () => {
    const sqlite = seededDatabase();
    sqlite.exec(`INSERT INTO wineries (id, site_id, name) VALUES ('winery', 'site', 'Original Winery');
      INSERT INTO wine_vintages (id, site_id, winery_id, base_name, display_name, vintage_label)
      VALUES ('wine', 'site', 'winery', 'Reserve', 'Reserve', 'NV');
      INSERT INTO bottles (id, site_id, wine_vintage_id) VALUES ('bottle_capture-0', 'site', 'wine');
      INSERT INTO bottle_captures (id, site_id, user_id, status) VALUES ('capture', 'site', 'user', 'extracting');`);
    const database = createD1Client(asD1(sqlite));
    await createCaptureRun({ captureId: "capture", database, runId: "run", status: "extracting" });
    await assert.rejects(
      importBottleCandidate({
        candidate: {
          wine: { wineryName: "Different Winery", designation: "Reserve" },
          bottle: {},
          rawSuggestion: {},
        },
        captureId: "capture",
        database,
        quantity: 2,
        runId: "run",
        siteId: "site",
      }),
      /different wine/u,
    );
    assert.equal(
      sqlite.prepare("SELECT wine_vintage_id FROM bottles").get()?.["wine_vintage_id"],
      "wine",
    );
    assert.equal(sqlite.prepare("SELECT count(*) AS count FROM wine_vintages").get()?.["count"], 1);
    assert.equal(
      sqlite.prepare("SELECT import_result_json FROM bottle_capture_runs").get()?.[
        "import_result_json"
      ],
      null,
    );
  });
});

function seededDatabase() {
  const database = migratedDatabase();
  database.exec(
    "INSERT INTO users (id, clerk_user_id) VALUES ('user', 'user'); INSERT INTO sites (id, name) VALUES ('site', 'Cellar')",
  );
  return database;
}
