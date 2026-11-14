import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { createD1Client } from "@chikachow/booze-db";

import { createBottleCapture } from "./capture-intake.ts";
import { asD1, migratedDatabase } from "./d1-support.ts";
import { deleteBottleCaptureData, deleteSiteData, drainR2ObjectDeletionQueue } from "./deletion.ts";
import { multipartBucket } from "./multipart-support.ts";

type BucketHooks = Parameters<typeof multipartBucket>[0];

function setup(
  hooks: (sqlite: DatabaseSync) => BucketHooks = () => ({}),
  files = [new File(["original evidence"], "label.jpg", { type: "image/jpeg" })],
) {
  const sqlite = migratedDatabase();
  sqlite.exec(`INSERT INTO users (id, clerk_user_id) VALUES ('user', 'user');
    INSERT INTO sites (id, name) VALUES ('site', 'Site')`);
  sqlite.exec("INSERT INTO site_memberships(site_id,user_id,role) VALUES('site','user','owner')");
  const storage = multipartBucket(hooks(sqlite));
  const d1 = asD1(sqlite);
  const input = {
    bucket: storage.bucket,
    database: createD1Client(d1),
    files,
    operationId: crypto.randomUUID(),
    positionHint: null,
    quantity: 1,
    siteId: "site",
    storageLocationId: null,
    userId: "user",
  };
  return { ...storage, sqlite, d1, input };
}

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function captureId(sqlite: DatabaseSync): string {
  const value = sqlite.prepare("SELECT id FROM bottle_captures").get()?.["id"];
  assert.equal(typeof value, "string");
  return String(value);
}

function count(sqlite: DatabaseSync, table: string): number {
  return Number(sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.["n"]);
}

function deleted(error: unknown): boolean {
  return error instanceof Error && "status" in error && error.status === 410;
}

await describe("capture intake ownership races", async () => {
  await it("durably registers every upload before sending any original bytes", async () => {
    let registeredParts = 0;
    const fixture = setup((sqlite) => ({
      beforePart(upload) {
        const manifest = sqlite
          .prepare("SELECT upload_id, r2_key FROM capture_image_uploads WHERE upload_id = ?")
          .get(upload.uploadId);
        assert.equal(manifest?.["upload_id"], upload.uploadId);
        assert.equal(manifest["r2_key"], upload.key);
        assert.equal(count(sqlite, "addition_receipts"), 1);
        registeredParts += 1;
      },
    }));
    const result = await createBottleCapture(fixture.input);
    assert.equal(result.status, "queued");
    assert.equal(registeredParts, 1);
    assert.equal(fixture.counts.completed, 1);
    assert.equal(count(fixture.sqlite, "bottle_capture_images"), 1);
    assert.deepEqual(fixture.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
  });

  await it(
    "deletes a site with one completed original and another delayed completion",
    { timeout: 5_000 },
    async () => {
      const entered = signal();
      const release = signal();
      let completions = 0;
      const fixture = setup(
        () => ({
          async beforeComplete() {
            completions += 1;
            if (completions === 2) {
              entered.resolve();
              await release.promise;
            }
          },
        }),
        [
          new File(["front evidence"], "front.jpg", { type: "image/jpeg" }),
          new File(["back evidence"], "back.jpg", { type: "image/jpeg" }),
        ],
      );
      const intake = createBottleCapture(fixture.input);
      await entered.promise;
      assert.equal(fixture.objects.size, 1);
      try {
        assert.equal(
          await deleteSiteData({ database: fixture.d1, siteId: "site", userId: "user" }),
          true,
        );
        await drainR2ObjectDeletionQueue({ bucket: fixture.bucket, database: fixture.d1 });
      } finally {
        release.resolve();
      }
      await assert.rejects(intake, deleted);
      for (const table of [
        "sites",
        "bottle_captures",
        "capture_image_uploads",
        "image_assets",
        "bottle_capture_images",
        "r2_object_deletion_queue",
      ]) {
        assert.equal(count(fixture.sqlite, table), 0, table);
      }
      assert.equal(fixture.objects.size, 0);
      assert.equal(count(fixture.sqlite, "addition_receipts"), 1);
      await assert.rejects(createBottleCapture(fixture.input), deleted);
      assert.equal(fixture.counts.completed, 1);
    },
  );

  await it("cannot send parts when upload registration rolls back, and retries with a new upload identity", async () => {
    const fixture = setup();
    fixture.sqlite.exec(`CREATE TRIGGER reject_upload_registration
      BEFORE UPDATE OF upload_id ON capture_image_uploads
      WHEN NEW.upload_id IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'registration interrupted'); END`);
    const first = await createBottleCapture(fixture.input);
    assert.equal(first.status, "upload_failed");
    assert.equal(fixture.counts.created, 1);
    assert.equal(fixture.counts.parts, 0);
    assert.equal(fixture.counts.completed, 0);
    assert.equal(
      fixture.sqlite.prepare("SELECT upload_id FROM capture_image_uploads").get()?.["upload_id"],
      null,
    );
    const interrupted = [...fixture.uploads.values()][0];
    assert.ok(interrupted);
    assert.equal(interrupted.state, "aborted");
    fixture.sqlite.exec("DROP TRIGGER reject_upload_registration");
    const retried = await createBottleCapture(fixture.input);
    assert.equal(retried.captureId, first.captureId);
    assert.equal(retried.status, "queued");
    assert.equal(fixture.counts.created, 2);
    assert.equal(fixture.counts.completed, 1);
    assert.equal(fixture.objects.size, 1);
  });

  await it("never completes an upload whose creation acknowledgement was lost", async () => {
    const fixture = setup();
    const create = fixture.bucket.createMultipartUpload.bind(fixture.bucket);
    let loseAcknowledgement = true;
    fixture.bucket.createMultipartUpload = async (key, options) => {
      const upload = await create(key, options);
      if (loseAcknowledgement) {
        loseAcknowledgement = false;
        throw new Error("Multipart creation acknowledgement lost");
      }
      return upload;
    };
    const first = await createBottleCapture(fixture.input);
    assert.equal(first.status, "upload_failed");
    assert.equal(fixture.counts.parts, 0);
    const unknownUpload = [...fixture.uploads.values()][0];
    assert.ok(unknownUpload);
    const retried = await createBottleCapture(fixture.input);
    assert.equal(retried.captureId, first.captureId);
    assert.equal(retried.status, "queued");
    assert.equal(unknownUpload.state, "pending");
    assert.equal(unknownUpload.bytes, undefined);
    assert.equal(fixture.counts.created, 2);
    assert.equal(fixture.counts.completed, 1);
    assert.equal(fixture.objects.size, 1);
  });

  await it("concurrent same-operation submissions retain one capture and one immutable original", async () => {
    const fixture = setup((sqlite) => ({
      beforePart(upload) {
        assert.equal(
          sqlite
            .prepare("SELECT count(*) AS n FROM capture_image_uploads WHERE upload_id = ?")
            .get(upload.uploadId)?.["n"],
          1,
        );
      },
    }));
    const results = await Promise.all([
      createBottleCapture(fixture.input),
      createBottleCapture(fixture.input),
    ]);
    assert.equal(results[0]?.captureId, results[1]?.captureId);
    assert.equal(count(fixture.sqlite, "bottle_captures"), 1);
    assert.equal(count(fixture.sqlite, "addition_receipts"), 1);
    assert.equal(count(fixture.sqlite, "image_assets"), 1);
    assert.equal(count(fixture.sqlite, "bottle_capture_images"), 1);
    assert.equal(fixture.counts.completed, 1);
    assert.equal(fixture.objects.size, 1);
    assert.equal(new TextDecoder().decode([...fixture.objects.values()][0]), "original evidence");
    assert.equal(
      fixture.sqlite.prepare("SELECT status FROM bottle_captures").get()?.["status"],
      "queued",
    );
    assert.deepEqual(fixture.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
  });

  await it(
    "a late unregistered multipart creation replays an intake already completed by its peer",
    { timeout: 5_000 },
    async () => {
      const firstEntered = signal();
      const secondEntered = signal();
      const releaseFirst = signal();
      const releaseSecond = signal();
      let creations = 0;
      const fixture = setup(() => ({
        async beforeCreate() {
          creations += 1;
          if (creations === 1) {
            firstEntered.resolve();
            await releaseFirst.promise;
          } else {
            secondEntered.resolve();
            await releaseSecond.promise;
          }
        },
      }));
      const first = createBottleCapture(fixture.input);
      await firstEntered.promise;
      const second = createBottleCapture(fixture.input);
      await secondEntered.promise;
      releaseFirst.resolve();
      let originalCaptureId: string | undefined;
      try {
        const result = await first;
        assert.equal(result.status, "queued");
        originalCaptureId = result.captureId;
      } finally {
        releaseSecond.resolve();
      }
      const replay = await second;
      assert.equal(replay.captureId, originalCaptureId);
      assert.equal(replay.status, "replayed");
      assert.equal(fixture.counts.created, 2);
      assert.equal(fixture.counts.parts, 1);
      assert.equal(fixture.counts.completed, 1);
      assert.equal(fixture.objects.size, 1);
      assert.equal(
        [...fixture.uploads.values()].filter((upload) => upload.state === "aborted").length,
        1,
      );
      assert.equal(count(fixture.sqlite, "bottle_capture_images"), 1);
    },
  );

  await it(
    "retains cleanup after abort failure, then fences completion before removing originals",
    { timeout: 5_000 },
    async () => {
      const entered = signal();
      const release = signal();
      let rejectAbort = true;
      const fixture = setup(() => ({
        async beforeComplete() {
          entered.resolve();
          await release.promise;
        },
        beforeAbort() {
          if (rejectAbort) throw new Error("Cancellation acknowledgement unavailable");
        },
      }));
      const intake = createBottleCapture(fixture.input);
      await entered.promise;
      try {
        assert.equal(
          await deleteBottleCaptureData({
            captureId: captureId(fixture.sqlite),
            database: fixture.d1,
            siteId: "site",
            userId: "user",
          }),
          true,
        );
        await assert.rejects(
          drainR2ObjectDeletionQueue({ bucket: fixture.bucket, database: fixture.d1 }),
          /Cancellation acknowledgement unavailable/u,
        );
        assert.equal(count(fixture.sqlite, "r2_object_deletion_queue"), 1);
        assert.equal(fixture.counts.deletes, 0);
      } finally {
        release.resolve();
      }
      await assert.rejects(intake, deleted);
      assert.equal(fixture.objects.size, 1);
      rejectAbort = false;
      await drainR2ObjectDeletionQueue({ bucket: fixture.bucket, database: fixture.d1 });
      assert.equal(count(fixture.sqlite, "r2_object_deletion_queue"), 0);
      assert.equal(fixture.objects.size, 0);
      const completed = [...fixture.uploads.values()][0];
      assert.ok(completed);
      await assert.rejects(
        fixture.bucket.resumeMultipartUpload(completed.key, completed.uploadId).complete([]),
        /10024/u,
      );
      assert.equal(fixture.objects.size, 0);
    },
  );

  await it(
    "cancellation before upload registration leaves no actionable late upload",
    { timeout: 5_000 },
    async () => {
      const entered = signal();
      const release = signal();
      const fixture = setup(() => ({
        async beforeCreate() {
          entered.resolve();
          await release.promise;
        },
      }));
      const intake = createBottleCapture(fixture.input);
      await entered.promise;
      try {
        assert.equal(
          await deleteBottleCaptureData({
            captureId: captureId(fixture.sqlite),
            database: fixture.d1,
            siteId: "site",
            userId: "user",
          }),
          true,
        );
        await drainR2ObjectDeletionQueue({ bucket: fixture.bucket, database: fixture.d1 });
      } finally {
        release.resolve();
      }
      await assert.rejects(intake, deleted);
      assert.equal(fixture.counts.created, 1);
      assert.equal(fixture.counts.parts, 0);
      assert.equal(fixture.counts.completed, 0);
      assert.equal(fixture.objects.size, 0);
      assert.equal(count(fixture.sqlite, "capture_image_uploads"), 0);
      assert.equal(count(fixture.sqlite, "r2_object_deletion_queue"), 0);
    },
  );
});
