// oxlint-disable import/max-dependencies -- Verifies commit-time permission races across capture and site operations.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createD1Client } from "@chikachow/booze-db";
import { Hono } from "hono";
import { problemResponseForError } from "./api/http.ts";
import { userIdForClerkUser } from "./api/ids.ts";
import type { Bindings } from "./api/types.ts";
import { createBottleCapture } from "./capture-intake.ts";
import { asD1, migratedDatabase } from "./d1-support.ts";
import { multipartBucket } from "./multipart-support.ts";
import { bottleCaptureRoutes } from "./routes/bottle-captures.ts";
import { siteRoutes } from "./routes/sites.ts";

const candidate = {
  wine: { wineryName: "Producer", designation: "Reserve" },
  bottle: { volumeMl: 750 },
};
const app = new Hono<{ Bindings: Bindings }>()
  .route("/", bottleCaptureRoutes)
  .route("/", siteRoutes)
  .onError(problemResponseForError);

function setup() {
  const sqlite = migratedDatabase();
  const userId = userIdForClerkUser("dev:tester");
  sqlite.prepare("INSERT INTO users(id,clerk_user_id) VALUES(?,'dev:tester')").run(userId);
  sqlite.exec("INSERT INTO sites(id,name) VALUES('site','Cellar')");
  sqlite
    .prepare("INSERT INTO site_memberships(site_id,user_id,role) VALUES('site',?,'owner')")
    .run(userId);
  sqlite
    .prepare(
      "INSERT INTO bottle_captures(id,site_id,user_id,status,workflow_instance_id) VALUES('capture','site',?,'needs_review','owner')",
    )
    .run(userId);
  sqlite
    .prepare(`INSERT INTO bottle_capture_runs(id,capture_id,status,extractor_version,prompt_version,schema_version,import_candidate_json,extraction_r2_key)
    VALUES('run','capture','needs_review','v1','v1','v1',?,'evidence.json')`)
    .run(JSON.stringify(candidate));
  sqlite
    .prepare(`INSERT INTO image_assets(id,site_id,sha256,r2_key,content_type,size_bytes,uploaded_by_user_id)
    VALUES('asset','site','digest','photo.jpg','image/jpeg',5,?)`)
    .run(userId);
  sqlite.exec(
    "INSERT INTO bottle_capture_images(capture_id,image_asset_id,sort_order) VALUES('capture','asset',0)",
  );
  const d1 = asD1(sqlite);
  const batch = d1.batch.bind(d1);
  let first = true;
  d1.batch = async (statements) => {
    if (first) {
      first = false;
      sqlite.exec("UPDATE site_memberships SET role='viewer'");
    }
    return batch(statements);
  };
  const storage = multipartBucket();
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Denied operations use only D1, local auth, and the real multipart fixture.
  const bindings = { DB: d1, IMAGE_BUCKET: storage.bucket } as Bindings;
  function snapshot() {
    return Object.fromEntries(
      [
        "sites",
        "bottle_captures",
        "bottle_capture_runs",
        "image_assets",
        "bottle_capture_images",
        "addition_receipts",
        "r2_object_deletion_queue",
        "bottles",
      ].map((table) => [table, sqlite.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()]),
    );
  }
  return {
    sqlite,
    d1,
    userId,
    ...storage,
    snapshot,
    async request(path: string, method: string, payload?: unknown) {
      return app.request(
        `http://localhost${path}`,
        {
          method,
          headers: { "x-dev-user": "tester", "content-type": "application/json" },
          ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        },
        bindings,
      );
    },
  };
}

await describe("capture and site commit authorization", async () => {
  await it("does not create a capture receipt, manifest, or photo after permission is revoked", async () => {
    const fixture = setup();
    const before = fixture.snapshot();
    await assert.rejects(
      createBottleCapture({
        bucket: fixture.bucket,
        database: createD1Client(fixture.d1),
        files: [new File(["photo"], "label.jpg", { type: "image/jpeg" })],
        operationId: crypto.randomUUID(),
        siteId: "site",
        userId: fixture.userId,
        quantity: 1,
        storageLocationId: null,
        positionHint: null,
      }),
      { status: 403 },
    );
    assert.deepEqual(fixture.snapshot(), before);
    assert.equal(fixture.counts.created, 0);
    assert.equal(
      fixture.sqlite.prepare("SELECT count(*) AS n FROM capture_image_uploads").get()?.["n"],
      0,
    );
  });

  for (const [path, method, payload] of [
    ["/bottle-captures/capture/retry", "POST", undefined],
    ["/bottle-captures/capture/review", "PATCH", { expectedRevision: 0, candidate }],
    ["/bottle-captures/capture/import", "POST", {}],
    ["/bottle-captures/capture", "DELETE", undefined],
    ["/sites/site", "PATCH", { name: "Changed" }],
    ["/sites/site", "DELETE", undefined],
  ] as const) {
    await it(`rolls back ${method} ${path} if permission is revoked before commit`, async () => {
      const fixture = setup();
      const before = fixture.snapshot();
      const response = await fixture.request(path, method, payload);
      assert.equal(response.status, 403, await response.clone().text());
      assert.deepEqual(fixture.snapshot(), before);
    });
  }
});
