// oxlint-disable import/max-dependencies -- Integration coverage crosses authenticated HTTP, durable receipts, and external storage boundaries.
// oxlint-disable typescript/no-unsafe-type-assertion -- HTTP integration fixtures supply the D1 and external binding methods exercised by each route.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Hono } from "hono";
import { userIdForClerkUser } from "./api/ids.ts";
import { problemResponseForError } from "./api/http.ts";
import type { Bindings } from "./api/types.ts";
import { multipartBucket } from "./multipart-support.ts";
import { asD1, migratedDatabase } from "./d1-support.ts";
import { bottleRoutes } from "./routes/bottles.ts";
import { siteRoutes } from "./routes/sites.ts";
import { bottleCaptureRoutes } from "./routes/bottle-captures.ts";

const app = new Hono<{ Bindings: Bindings }>()
  .route("/", bottleRoutes)
  .route("/", bottleCaptureRoutes)
  .route("/", siteRoutes)
  .onError(problemResponseForError);
const payload = {
  operationId: "a9c7004f-f2ab-4b94-93ac-21511459477d",
  siteId: "site",
  quantity: 2,
  wine: { wineryName: "Estate", designation: "Reserve" },
};
function setup() {
  const sqlite = migratedDatabase();
  const userId = userIdForClerkUser("dev:tester");
  sqlite.prepare("INSERT INTO users (id, clerk_user_id) VALUES (?, 'dev:tester')").run(userId);
  sqlite.exec("INSERT INTO sites (id,name) VALUES ('site','Cellar')");
  sqlite
    .prepare("INSERT INTO site_memberships(site_id,user_id,role) VALUES ('site',?,'owner')")
    .run(userId);
  return sqlite;
}
async function bottle(bindings: Bindings, input = payload) {
  return app.request(
    "http://localhost/bottles",
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-dev-user": "tester" },
      body: JSON.stringify(input),
    },
    bindings,
  );
}
await describe("durable addition receipts", async () => {
  await it("returns original stock IDs after a committed response is lost, even after names change", async () => {
    const sqlite = setup();
    const bindings = { DB: asD1(sqlite) } as Bindings;
    const first = await bottle(bindings);
    assert.equal(first.status, 201);
    const original: unknown = await first.json();
    sqlite.exec("UPDATE sites SET name = 'Renamed'; UPDATE wineries SET name = 'Renamed producer'");
    const replay = await bottle(bindings);
    assert.equal(replay.status, 201);
    assert.deepEqual(await replay.json(), original);
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM bottles").get()?.["n"], 2);
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM wine_vintages").get()?.["n"], 1);
  });
  await it("commits only one simultaneous addition and rejects changed input", async () => {
    const sqlite = setup();
    const bindings = { DB: asD1(sqlite) } as Bindings;
    const responses = await Promise.all([bottle(bindings), bottle(bindings)]);
    assert.deepEqual(
      responses.map((r) => r.status),
      [201, 201],
    );
    assert.deepEqual(await responses[0]?.json(), await responses[1]?.json());
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM bottles").get()?.["n"], 2);
    assert.equal((await bottle(bindings, { ...payload, quantity: 3 })).status, 409);
    sqlite.exec("UPDATE site_memberships SET role = 'viewer'");
    assert.equal((await bottle(bindings)).status, 403);
  });
  await it("requires operation identity and never recreates a site after a completed addition is deleted", async () => {
    const sqlite = setup();
    const bindings = { DB: asD1(sqlite) } as Bindings;
    const absentIdentity = await app.request(
      "http://localhost/bottles",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-dev-user": "tester" },
        body: JSON.stringify({ siteId: "site", wine: payload.wine }),
      },
      bindings,
    );
    assert.equal(absentIdentity.status, 400);
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM bottles").get()?.["n"], 0);
    assert.equal((await bottle(bindings)).status, 201);
    const deletion = await app.request(
      "http://localhost/sites/site",
      { method: "DELETE", headers: { "x-dev-user": "tester" } },
      bindings,
    );
    assert.equal(deletion.status, 204);
    assert.equal((await bottle(bindings)).status, 404);
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM sites").get()?.["n"], 0);
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM addition_receipts").get()?.["n"], 1);
    assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
  });
  await it("recovers the same stock after D1 commits but loses its acknowledgement", async () => {
    const sqlite = setup();
    const d1 = asD1(sqlite);
    const batch = d1.batch.bind(d1);
    let loseAcknowledgement = true;
    d1.batch = async <T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
      const result = await batch<T>(statements);
      if (loseAcknowledgement) {
        loseAcknowledgement = false;
        throw new Error("committed acknowledgement lost");
      }
      return result;
    };
    const bindings = { DB: d1 } as Bindings;
    const first = await bottle(bindings);
    assert.equal(first.status, 201);
    const replay = await bottle(bindings);
    assert.deepEqual(await replay.json(), await first.json());
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM bottles").get()?.["n"], 2);
  });
  await it("rolls a receipt back with a failed stock transaction", async () => {
    const sqlite = setup();
    const bindings = { DB: asD1(sqlite) } as Bindings;
    sqlite.exec(
      "CREATE TRIGGER reject_stock BEFORE INSERT ON bottles BEGIN SELECT RAISE(ABORT, 'stock rejected'); END",
    );
    assert.equal((await bottle(bindings)).status, 500);
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM addition_receipts").get()?.["n"], 0);
    sqlite.exec("DROP TRIGGER reject_stock");
    assert.equal((await bottle(bindings)).status, 201);
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM bottles").get()?.["n"], 2);
  });
  await it("replays the same capture without uploading or launching twice after a lost launch acknowledgement", async () => {
    const sqlite = setup();
    sqlite.exec(
      "INSERT INTO storage_locations (id,site_id,name) VALUES ('location','site','Rack')",
    );
    const { bucket, counts } = multipartBucket();
    let launches = 0;
    const bindings = {
      DB: asD1(sqlite),
      IMAGE_BUCKET: bucket,
      BOTTLE_CAPTURE_WORKFLOW: {
        async create() {
          launches += 1;
          throw new Error("launch acknowledgement lost");
        },
      },
    } as unknown as Bindings;
    const send = async (bytes = "photo") => {
      const body = new FormData();
      body.set("operationId", payload.operationId);
      body.set("siteId", "site");
      body.set("quantity", "2");
      body.set("storageLocationId", "location");
      body.set("images", new File([bytes], "label.jpg", { type: "image/jpeg" }));
      return app.request(
        "http://localhost/bottle-captures",
        { method: "POST", headers: { "x-dev-user": "tester" }, body },
        bindings,
      );
    };
    const first = await send();
    assert.equal(first.status, 201);
    const original: unknown = await first.json();
    sqlite.exec(
      "UPDATE bottle_captures SET storage_location_id = NULL; DELETE FROM storage_locations",
    );
    const replay = await send();
    assert.equal(replay.status, 201);
    assert.deepEqual(await replay.json(), original);
    assert.equal(counts.completed, 1);
    assert.equal(launches, 1);
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM bottle_captures").get()?.["n"], 1);
    assert.equal((await send("different image")).status, 409);
    sqlite.exec("UPDATE site_memberships SET role = 'viewer'");
    assert.equal((await send()).status, 403);
  });
  await it("completes one original and launches once for simultaneous identical capture submissions", async () => {
    const sqlite = setup();
    const { bucket, counts, objects } = multipartBucket();
    let launches = 0;
    const bindings = {
      DB: asD1(sqlite),
      IMAGE_BUCKET: bucket,
      BOTTLE_CAPTURE_WORKFLOW: {
        async create({ id }: { readonly id: string }) {
          launches += 1;
          return { id };
        },
      },
    } as unknown as Bindings;
    const send = async () => {
      const body = new FormData();
      body.set("operationId", payload.operationId);
      body.set("siteId", "site");
      body.set("quantity", "2");
      body.append("images", new File(["front evidence"], "front.jpg", { type: "image/jpeg" }));
      return app.request(
        "http://localhost/bottle-captures",
        { method: "POST", headers: { "x-dev-user": "tester" }, body },
        bindings,
      );
    };
    const responses = await Promise.all([send(), send()]);
    assert.deepEqual(
      responses.map((response) => response.status),
      [201, 201],
    );
    const [first, second] = await Promise.all(responses.map(async (response) => response.json()));
    assert.deepEqual(first, second);
    assert.equal(counts.completed, 1);
    assert.equal(objects.size, 1);
    assert.equal(launches, 1);
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM bottle_captures").get()?.["n"], 1);
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM bottle_capture_images").get()?.["n"], 1);
  });
});
