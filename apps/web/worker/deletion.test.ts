import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { deleteBottleCaptureData, deleteSiteData, drainR2ObjectDeletionQueue } from "./deletion.ts";
import { asD1, migratedDatabase } from "./d1-support.ts";

await describe("durable deletion", async () => {
  await it("preserves the entire site when a capture is processing", async () => {
    const database = migratedDatabase();
    seedSite(database, "site-1");
    seedCatalogueAndCapture(database, "site-1", "capture-1", "asset-1");
    database.exec("UPDATE bottle_captures SET status = 'extracting'");
    assert.equal(
      await deleteSiteData({ database: asD1(database), siteId: "site-1", userId: "user-1" }),
      false,
    );
    for (const table of [
      "sites",
      "bottles",
      "wine_vintages",
      "bottle_locations",
      "bottle_captures",
      "bottle_capture_runs",
      "image_assets",
      "label_extractions",
    ]) {
      assert.equal(scalar(database, `SELECT count(*) FROM ${table}`), 1, table);
    }
    assert.deepEqual(queuedKeys(database), []);
  });

  await it("deletes a complete site while preserving audit rows unchanged", async () => {
    const database = migratedDatabase();
    seedSite(database, "site-1");
    seedCatalogueAndCapture(database, "site-1", "capture-1", "asset-1");
    const auditBefore = row(database, "SELECT * FROM mcp_tool_audit_events WHERE id = 'audit-1'");

    await deleteSiteData({ database: asD1(database), siteId: "site-1", userId: "user-1" });

    for (const table of [
      "sites",
      "site_memberships",
      "wineries",
      "wine_vintages",
      "wine_constituents",
      "review_sources",
      "critic_reviews",
      "wine_awards",
      "storage_locations",
      "bottles",
      "bottle_locations",
      "image_assets",
      "bottle_captures",
      "bottle_capture_images",
      "bottle_capture_runs",
      "label_extractions",
    ]) {
      assert.equal(scalar(database, `SELECT count(*) FROM ${table}`), 0, table);
    }
    assert.deepEqual(
      row(database, "SELECT * FROM mcp_tool_audit_events WHERE id = 'audit-1'"),
      auditBefore,
    );
    assert.deepEqual(queuedKeys(database), [
      "sites/site-1/artifacts/capture-1/error.json",
      "sites/site-1/artifacts/capture-1/extraction.json",
      "sites/site-1/images/asset-1.jpg",
      "sites/site-1/thumbnails/asset-1.webp",
    ]);
  });

  await it("keeps shared images until the last capture is deleted", async () => {
    const database = migratedDatabase();
    seedSite(database, "site-1");
    seedCapture(database, "site-1", "capture-1", "asset-1", 0);
    seedCapture(database, "site-1", "capture-2", "asset-1", 1);

    await deleteBottleCaptureData({
      captureId: "capture-1",
      database: asD1(database),
      siteId: "site-1",
      userId: "user-1",
    });

    assert.equal(scalar(database, "SELECT count(*) FROM image_assets"), 1);
    assert.equal(scalar(database, "SELECT count(*) FROM bottle_captures"), 1);
    assert.deepEqual(queuedKeys(database), [
      "sites/site-1/artifacts/capture-1/error.json",
      "sites/site-1/artifacts/capture-1/extraction.json",
    ]);

    await deleteBottleCaptureData({
      captureId: "capture-2",
      database: asD1(database),
      siteId: "site-1",
      userId: "user-1",
    });

    assert.equal(scalar(database, "SELECT count(*) FROM image_assets"), 0);
    assert.equal(scalar(database, "SELECT count(*) FROM bottle_captures"), 0);
    assert.deepEqual(queuedKeys(database), [
      "sites/site-1/artifacts/capture-1/error.json",
      "sites/site-1/artifacts/capture-1/extraction.json",
      "sites/site-1/artifacts/capture-2/error.json",
      "sites/site-1/artifacts/capture-2/extraction.json",
      "sites/site-1/images/asset-1.jpg",
      "sites/site-1/thumbnails/asset-1.webp",
    ]);
  });

  await it("retains queued keys after an R2 failure and removes them after a retry", async () => {
    const database = migratedDatabase();
    database.exec(
      `INSERT INTO r2_object_deletion_queue (r2_key, source_kind, source_id)
       VALUES ('one', 'test', '1'), ('two', 'test', '2')`,
    );
    const failedBucket = bucketThatDeletes({ fail: true });

    await assert.rejects(
      drainR2ObjectDeletionQueue({
        bucket: failedBucket.bucket,
        database: asD1(database),
      }),
      /R2 unavailable/u,
    );
    assert.deepEqual(queuedKeys(database), ["one", "two"]);
    assert.deepEqual(
      database
        .prepare("SELECT attempts, last_error FROM r2_object_deletion_queue ORDER BY r2_key")
        .all()
        .map((entry) => ({
          attempts: entry["attempts"],
          last_error: entry["last_error"],
        })),
      [
        { attempts: 1, last_error: "R2 unavailable" },
        { attempts: 1, last_error: "R2 unavailable" },
      ],
    );

    const successfulBucket = bucketThatDeletes({ fail: false });
    assert.equal(
      await drainR2ObjectDeletionQueue({
        bucket: successfulBucket.bucket,
        database: asD1(database),
      }),
      2,
    );
    assert.deepEqual(successfulBucket.deleted, [["one", "two"]]);
    assert.deepEqual(queuedKeys(database), []);
  });
});

function seedSite(database: DatabaseSync, siteId: string): void {
  database
    .prepare("INSERT OR IGNORE INTO users (id, clerk_user_id) VALUES ('user-1', 'clerk-1')")
    .run();
  database.prepare("INSERT INTO sites (id, name) VALUES (?, 'Cellar')").run(siteId);
  database
    .prepare(
      `INSERT INTO site_memberships (site_id, user_id, role)
       VALUES (?, 'user-1', 'owner')`,
    )
    .run(siteId);
}

function seedCatalogueAndCapture(
  database: DatabaseSync,
  siteId: string,
  captureId: string,
  imageAssetId: string,
): void {
  database
    .prepare("INSERT INTO wineries (id, site_id, name) VALUES ('winery-1', ?, 'Winery')")
    .run(siteId);
  database
    .prepare(
      `INSERT INTO wine_vintages (
         id, site_id, winery_id, base_name, display_name, vintage_label
       ) VALUES ('wine-1', ?, 'winery-1', 'Reserve', 'Reserve', '2020')`,
    )
    .run(siteId);
  database.prepare("INSERT INTO grape_varieties (id, name) VALUES ('grape-1', 'Shiraz')").run();
  database
    .prepare(
      `INSERT INTO wine_constituents (site_id, wine_vintage_id, grape_variety_id)
       VALUES (?, 'wine-1', 'grape-1')`,
    )
    .run(siteId);
  database
    .prepare(
      `INSERT INTO storage_locations (id, site_id, name, location_type)
       VALUES ('location-1', ?, 'Rack', 'rack')`,
    )
    .run(siteId);
  database
    .prepare(
      `INSERT INTO bottles (id, site_id, wine_vintage_id)
       VALUES ('bottle-1', ?, 'wine-1')`,
    )
    .run(siteId);
  database
    .prepare(
      `INSERT INTO bottle_locations (bottle_id, site_id, storage_location_id)
       VALUES ('bottle-1', ?, 'location-1')`,
    )
    .run(siteId);
  database
    .prepare(
      `INSERT INTO review_sources (id, site_id, name)
       VALUES ('source-1', ?, 'Critic')`,
    )
    .run(siteId);
  database
    .prepare(
      `INSERT INTO critic_reviews (
         id, site_id, wine_vintage_id, review_source_id, rating_text, created_by_user_id
       ) VALUES ('review-1', ?, 'wine-1', 'source-1', '95 points', 'user-1')`,
    )
    .run(siteId);
  database
    .prepare(
      `INSERT INTO wine_awards (
         id, site_id, wine_vintage_id, award_name, award_level, created_by_user_id
       ) VALUES ('award-1', ?, 'wine-1', 'Show', 'Gold', 'user-1')`,
    )
    .run(siteId);
  seedCapture(database, siteId, captureId, imageAssetId, 0);
  database
    .prepare(
      `INSERT INTO label_extractions (
         id, bottle_id, wine_vintage_id, capture_id, capture_run_id, extracted_fields_json
       ) VALUES ('label-1', 'bottle-1', 'wine-1', ?, ?, '{}')`,
    )
    .run(captureId, `${captureId}-run`);
  database
    .prepare(
      `INSERT INTO mcp_tool_audit_events (
         id, user_id, site_id, tool_name, target_kind, target_mcp_id,
         target_persisted_id, input_json, before_json, after_json, affected_record_count
       ) VALUES (
         'audit-1', 'user-1', ?, 'cellar.mark_bottle_consumed', 'bottle', 'bottle-1',
         'bottle-1', '{"bottleId":"bottle-1"}', '{"status":"in_stock"}',
         '{"status":"consumed"}', 1
       )`,
    )
    .run(siteId);
}

function seedCapture(
  database: DatabaseSync,
  siteId: string,
  captureId: string,
  imageAssetId: string,
  sortOrder: number,
): void {
  database
    .prepare(
      `INSERT OR IGNORE INTO image_assets (
         id, site_id, sha256, r2_key, content_type, size_bytes,
         thumbnail_r2_key, uploaded_by_user_id
       ) VALUES (?, ?, 'sha-1', ?, 'image/jpeg', 100, ?, 'user-1')`,
    )
    .run(
      imageAssetId,
      siteId,
      `sites/${siteId}/images/${imageAssetId}.jpg`,
      `sites/${siteId}/thumbnails/${imageAssetId}.webp`,
    );
  database
    .prepare(
      `INSERT INTO bottle_captures (id, site_id, user_id, status)
       VALUES (?, ?, 'user-1', 'failed')`,
    )
    .run(captureId, siteId);
  database
    .prepare(
      `INSERT INTO bottle_capture_images (capture_id, image_asset_id, sort_order)
       VALUES (?, ?, ?)`,
    )
    .run(captureId, imageAssetId, sortOrder);
  database
    .prepare(
      `INSERT INTO bottle_capture_runs (
         id, capture_id, status, extractor_version, prompt_version, schema_version,
         extraction_r2_key, error_detail_r2_key
       ) VALUES (?, ?, 'failed', 'v1', 'v1', 'v1', ?, ?)`,
    )
    .run(
      `${captureId}-run`,
      captureId,
      `sites/${siteId}/artifacts/${captureId}/extraction.json`,
      `sites/${siteId}/artifacts/${captureId}/error.json`,
    );
}

function bucketThatDeletes({ fail }: { readonly fail: boolean }): {
  readonly bucket: R2Bucket;
  readonly deleted: string[][];
} {
  const deleted: string[][] = [];
  return {
    /* oxlint-disable typescript/no-unsafe-type-assertion -- Test double only implements delete. */
    bucket: {
      async delete(keys: string | string[]): Promise<void> {
        if (fail) {
          throw new Error("R2 unavailable");
        }
        deleted.push(typeof keys === "string" ? [keys] : [...keys]);
      },
    } as unknown as R2Bucket,
    /* oxlint-enable typescript/no-unsafe-type-assertion */
    deleted,
  };
}

function queuedKeys(database: DatabaseSync): readonly string[] {
  return database
    .prepare("SELECT r2_key FROM r2_object_deletion_queue ORDER BY r2_key")
    .all()
    .map((entry) => String(entry["r2_key"]));
}

function scalar(database: DatabaseSync, query: string): number {
  return Number(Object.values(row(database, query))[0]);
}

function row(database: DatabaseSync, query: string): Record<string, unknown> {
  const result = database.prepare(query).get();
  assert.notEqual(result, undefined);
  return { ...result };
}
