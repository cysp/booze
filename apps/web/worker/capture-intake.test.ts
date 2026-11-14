import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createD1Client } from "@chikachow/booze-db";
import { createBottleCapture } from "./capture-intake.ts";
import { deleteBottleCaptureData, drainR2ObjectDeletionQueue } from "./deletion.ts";
import { asD1, migratedDatabase } from "./d1-support.ts";
import { multipartBucket } from "./multipart-support.ts";

function setup(hooks: Parameters<typeof multipartBucket>[0] = {}) {
  const sqlite = migratedDatabase();
  sqlite.exec(
    "INSERT INTO users(id,clerk_user_id) VALUES('user','user'); INSERT INTO sites(id,name) VALUES('site','Site')",
  );
  const storage = multipartBucket(hooks);
  const d1 = asD1(sqlite);
  const input = {
    ...storage,
    database: createD1Client(d1),
    operationId: crypto.randomUUID(),
    files: [new File(["original evidence"], "label.jpg", { type: "image/jpeg" })],
    siteId: "site",
    userId: "user",
    quantity: 1,
    storageLocationId: null,
    positionHint: null,
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
await describe("recoverable capture image intake", async () => {
  await it("resumes an interrupted saved intake with the same capture and original files", async () => {
    let fail = true;
    const fixture = setup({
      beforeComplete() {
        if (fail) {
          fail = false;
          throw new Error("Connection interrupted before commit");
        }
      },
    });
    const first = await createBottleCapture(fixture.input);
    assert.equal(first.status, "upload_failed");
    const retried = await createBottleCapture(fixture.input);
    assert.equal(retried.captureId, first.captureId);
    assert.equal(retried.status, "queued");
    assert.equal(fixture.objects.size, 1);
    assert.equal(
      fixture.sqlite.prepare("SELECT count(*) AS n FROM bottle_capture_images").get()?.["n"],
      1,
    );
  });
  await it("recovers a lost multipart completion acknowledgement without rewriting evidence", async () => {
    let fail = true;
    const fixture = setup({
      afterComplete() {
        if (fail) {
          fail = false;
          throw new Error("Commit acknowledgement lost");
        }
      },
    });
    const first = await createBottleCapture(fixture.input);
    assert.equal(first.status, "upload_failed");
    const retried = await createBottleCapture(fixture.input);
    assert.equal(retried.captureId, first.captureId);
    assert.equal(retried.status, "queued");
    assert.equal(fixture.objects.size, 1);
    assert.equal(fixture.counts.completed, 1);
  });
  await it("cancels an intake before a delayed completion can recreate its object", async () => {
    const entered = signal(),
      release = signal();
    const fixture = setup({
      async beforeComplete() {
        entered.resolve();
        await release.promise;
      },
    });
    const upload = createBottleCapture(fixture.input);
    await entered.promise;
    const capture = fixture.sqlite.prepare("SELECT id FROM bottle_captures").get()?.["id"];
    assert.equal(typeof capture, "string");
    try {
      assert.equal(
        await deleteBottleCaptureData({ captureId: String(capture), database: fixture.d1 }),
        true,
      );
      await drainR2ObjectDeletionQueue({ bucket: fixture.bucket, database: fixture.d1 });
    } finally {
      release.resolve();
    }
    await upload.catch(() => null);
    assert.equal(fixture.objects.size, 0);
    assert.equal(fixture.sqlite.prepare("SELECT count(*) AS n FROM image_assets").get()?.["n"], 0);
    assert.equal(
      fixture.sqlite.prepare("SELECT count(*) AS n FROM bottle_captures").get()?.["n"],
      0,
    );
    assert.equal(
      fixture.sqlite.prepare("SELECT count(*) AS n FROM r2_object_deletion_queue").get()?.["n"],
      0,
    );
  });
});
