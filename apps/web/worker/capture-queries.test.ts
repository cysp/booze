// oxlint-disable import/max-dependencies -- Tests the capture HTTP read interface against migrated SQL storage.
import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { createD1Client } from "@chikachow/booze-db";
import { Hono } from "hono";
import { z } from "zod";

import { capturePageSchema, captureStatusPageSchema } from "../shared/capture-read-resources.ts";
import { captureResourceSchema } from "../shared/capture-resources.ts";
import { captureStatuses } from "../shared/capture-status.ts";
import { problemResponseForError } from "./api/http.ts";
import { userIdForClerkUser } from "./api/ids.ts";
import type { Bindings } from "./api/types.ts";
import { getCaptureCounts } from "./capture-store.ts";
import { asD1, migratedDatabase } from "./d1-support.ts";
import { multipartBucket } from "./multipart-support.ts";
import { bottleCaptureRoutes } from "./routes/bottle-captures.ts";

const app = new Hono<{ Bindings: Bindings }>()
  .route("/", bottleCaptureRoutes)
  .onError(problemResponseForError);

function setup(context: TestContext) {
  const sqlite = migratedDatabase();
  context.after(() => {
    sqlite.close();
  });
  const userId = userIdForClerkUser("dev:tester");
  sqlite.prepare("INSERT INTO users (id, clerk_user_id) VALUES (?, 'dev:tester')").run(userId);
  sqlite.exec(`
    INSERT INTO users (id, clerk_user_id) VALUES ('author', 'author');
    INSERT INTO sites (id, name) VALUES ('site', 'Cellar'), ('private', 'Private');
  `);
  sqlite
    .prepare("INSERT INTO site_memberships (site_id, user_id, role) VALUES ('site', ?, 'owner')")
    .run(userId);
  const d1 = asD1(sqlite);
  const queries: string[] = [];
  const prepare = d1.prepare.bind(d1);
  d1.prepare = (query) => {
    queries.push(query);
    return prepare(query);
  };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Read routes only require D1 and local development authentication.
  const bindings = { DB: d1 } as Bindings;
  const addCapture = (id: string, status = "queued", siteId = "site", createdAt = "2026-01-01") => {
    sqlite
      .prepare(
        "INSERT INTO bottle_captures (id, site_id, user_id, status, created_at) VALUES (?, ?, 'author', ?, ?)",
      )
      .run(id, siteId, status, createdAt);
  };
  return {
    addCapture,
    bindings,
    database: createD1Client(d1),
    queries,
    sqlite,
    userId,
    request: async (path: string, init: RequestInit = {}, runtimeBindings = bindings) => {
      const headers = new Headers(init.headers);
      headers.set("x-dev-user", "tester");
      return app.request(`http://localhost${path}`, { ...init, headers }, runtimeBindings);
    },
  };
}

function seedPages(fixture: ReturnType<typeof setup>) {
  let index = 0;
  for (const status of captureStatuses) {
    for (let repeat = 0; repeat < 18; repeat += 1) {
      fixture.addCapture(
        `capture-${String(index).padStart(3, "0")}`,
        status,
        "site",
        index < 4 ? "2026-02-01" : "2026-01-01",
      );
      index += 1;
    }
  }
  fixture.addCapture("legacy unknown status", "old_failure");
  for (let hiddenIndex = 0; hiddenIndex < 20; hiddenIndex += 1) {
    fixture.addCapture(`hidden-${hiddenIndex}`, "needs_review", "private");
  }
}

await describe("bounded capture reads", async () => {
  await it("pages every authorized summary once with stable ties and full-scope counts", async (context) => {
    const fixture = setup(context);
    seedPages(fixture);
    const firstResponse = await fixture.request("/bottle-captures");
    assert.equal(firstResponse.status, 200, await firstResponse.clone().text());
    const first = capturePageSchema.parse(await firstResponse.json());
    assert.equal(first.data.length, 50);
    assert.equal(first.totalCount, 127);
    assert.deepEqual(first.counts, { actionable: 55, processing: 72, imported: 18 });
    assert.deepEqual(await getCaptureCounts(fixture), first.counts);

    for (const view of ["action", "all"]) {
      const visited: string[] = [];
      let pageToken: string | null = null;
      do {
        const query = new URLSearchParams({ view, limit: "17" });
        if (pageToken !== null) query.set("pageToken", pageToken);
        const response = await fixture.request(`/bottle-captures?${query}`);
        assert.equal(response.status, 200, await response.clone().text());
        const page = capturePageSchema.parse(await response.json());
        assert.ok(page.data.length <= 17);
        assert.equal(page.totalCount, view === "all" ? 145 : 127);
        assert.deepEqual(page.counts, first.counts);
        visited.push(...page.data.map((capture) => capture.id));
        pageToken = page.nextPageToken;
      } while (pageToken !== null);
      const expected = fixture.sqlite
        .prepare(
          `SELECT id FROM bottle_captures WHERE site_id = 'site' ${view === "all" ? "" : "AND status != 'imported'"}
          ORDER BY created_at DESC, id ASC`,
        )
        .all()
        .map((row) => row["id"]);
      assert.deepEqual(visited, expected);
      assert.equal(new Set(visited).size, visited.length);
    }
    const maximum = await fixture.request("/bottle-captures?view=all&limit=100");
    assert.equal(capturePageSchema.parse(await maximum.json()).data.length, 100);
  });

  await it("keeps candidates and evidence out of list/poll SQL and preserves legacy preview URLs", async (context) => {
    const fixture = setup(context);
    const captureId = " legacy/capture 🍷 ";
    const imageId = " legacy/image?🍇 ";
    fixture.addCapture(captureId, "needs_review");
    fixture.sqlite
      .prepare("UPDATE bottle_captures SET review_candidate_json = ? WHERE id = ?")
      .run("intentionally invalid historical review JSON", captureId);
    fixture.sqlite
      .prepare(
        "INSERT INTO image_assets (id, site_id, sha256, r2_key, content_type, size_bytes, uploaded_by_user_id) VALUES (?, 'site', 'sha', 'legacy-original', 'image/heic', 8000000, 'author')",
      )
      .run(imageId);
    fixture.sqlite
      .prepare(
        "INSERT INTO bottle_capture_images (capture_id, image_asset_id, sort_order, original_filename) VALUES (?, ?, 0, 'Original label.heic')",
      )
      .run(captureId, imageId);
    fixture.sqlite
      .prepare(
        "INSERT INTO bottle_capture_runs (id,capture_id,status,extractor_version,prompt_version,schema_version,import_candidate_json,extraction_r2_key) VALUES ('run',?,'needs_review','v1','v1','v1',?,'evidence/original.json')",
      )
      .run(captureId, JSON.stringify({ privateEvidence: "large raw candidate" }));

    const page = capturePageSchema.parse(await (await fixture.request("/bottle-captures")).json());
    assert.deepEqual(page.data[0]?.previewImage, {
      imageAssetId: imageId,
      imageUrl: `/api/bottle-captures/${encodeURIComponent(captureId)}/images/${encodeURIComponent(imageId)}`,
    });
    assert.equal(page.data[0]?.imageCount, 1);
    const statuses = await fixture.request(
      `/bottle-capture-statuses?${new URLSearchParams({ captureId })}`,
    );
    assert.equal(statuses.status, 200);
    assert.equal(captureStatusPageSchema.parse(await statuses.json()).data[0]?.id, captureId);
    const sql = fixture.queries.join("\n");
    assert.doesNotMatch(
      sql,
      /bottle_capture_runs|review_candidate_json|import_candidate_json|extraction_r2_key|imported_bottle_ids_json|error_detail/iu,
    );
    assert.equal("latestRun" in (page.data[0] ?? {}), false);
    assert.equal("reviewCandidate" in (page.data[0] ?? {}), false);
    assert.equal(
      fixture.sqlite.prepare("SELECT r2_key FROM image_assets").get()?.["r2_key"],
      "legacy-original",
    );
  });

  await it("loads only selected capture detail and returns identical missing/private failures", async (context) => {
    const fixture = setup(context);
    for (const id of ["status", "other"]) fixture.addCapture(id, "needs_review");
    fixture.addCapture("hidden", "needs_review", "private");
    fixture.sqlite.exec(`
      INSERT INTO image_assets (id,site_id,sha256,r2_key,content_type,size_bytes,uploaded_by_user_id)
        VALUES ('image','site','sha','original.heic','image/heic',10,'author');
      INSERT INTO bottle_capture_images (capture_id,image_asset_id,sort_order)
        VALUES ('status','image',0), ('other','image',0);
      UPDATE bottle_captures SET review_candidate_json = '{' WHERE id = 'other';
      INSERT INTO bottle_capture_runs (id,capture_id,status,extractor_version,prompt_version,schema_version,attempt_number,import_candidate_json,extraction_r2_key)
        VALUES ('old','status','needs_review','v1','v1','v1',1,'{"original":"old"}','old.json'),
               ('latest','status','needs_review','v1','v1','v1',2,'{"original":"exact raw"}','retained.json'),
               ('other-run','other','needs_review','v1','v1','v1',1,'{"private":"other"}','other.json');
    `);
    const response = await fixture.request("/bottle-captures/status");
    assert.equal(response.status, 200, await response.clone().text());
    const { data } = z.object({ data: captureResourceSchema }).parse(await response.json());
    assert.equal(data.id, "status");
    assert.deepEqual(data.latestRun?.importCandidate, { original: "exact raw" });
    assert.equal(data.latestRun?.extractionR2Key, "retained.json");
    assert.equal(data.images.length, 1);
    const missing = await fixture.request("/bottle-captures/missing");
    const privateCapture = await fixture.request("/bottle-captures/hidden");
    assert.equal(missing.status, 404);
    assert.equal(privateCapture.status, 404);
    assert.deepEqual(await missing.json(), await privateCapture.json());
    for (const corrupted of ["{", '{"wine":{"grapeVarieties":"invalid"},"bottle":{}}']) {
      fixture.sqlite
        .prepare("UPDATE bottle_captures SET review_candidate_json = ? WHERE id = 'other'")
        .run(corrupted);
      const invalid = await fixture.request("/bottle-captures/other");
      assert.equal(invalid.status, 500);
      assert.equal(
        fixture.sqlite
          .prepare("SELECT review_candidate_json FROM bottle_captures WHERE id = 'other'")
          .get()?.["review_candidate_json"],
        corrupted,
      );
    }
    assert.equal(
      fixture.sqlite
        .prepare("SELECT extraction_r2_key FROM bottle_capture_runs WHERE id = 'other-run'")
        .get()?.["extraction_r2_key"],
      "other.json",
    );
  });

  await it("observes imported tracked IDs after they leave the action page and omits inaccessible IDs", async (context) => {
    const fixture = setup(context);
    seedPages(fixture);
    const first = capturePageSchema.parse(
      await (await fixture.request("/bottle-captures?limit=1")).json(),
    );
    const trackedId = first.data[0]?.id;
    assert.ok(trackedId !== undefined);
    fixture.sqlite
      .prepare("UPDATE bottle_captures SET status = 'imported' WHERE id = ?")
      .run(trackedId);
    const after = capturePageSchema.parse(
      await (await fixture.request("/bottle-captures?limit=1")).json(),
    );
    assert.notEqual(after.data[0]?.id, trackedId);
    const query = new URLSearchParams();
    for (const id of [trackedId, "hidden-0", "missing"]) query.append("captureId", id);
    const statuses = captureStatusPageSchema.parse(
      await (await fixture.request(`/bottle-capture-statuses?${query}`)).json(),
    );
    assert.deepEqual(
      statuses.data.map(({ id, status }) => ({ id, status })),
      [{ id: trackedId, status: "imported" }],
    );
    const hundred = new URLSearchParams();
    for (let index = 0; index < 100; index += 1) {
      hundred.append("captureId", `capture-${String(index).padStart(3, "0")}`);
    }
    const hundredResponse = await fixture.request(`/bottle-capture-statuses?${hundred}`);
    assert.equal(hundredResponse.status, 200);
    assert.equal(captureStatusPageSchema.parse(await hundredResponse.json()).data.length, 100);
    fixture.sqlite.prepare("DELETE FROM site_memberships WHERE user_id = ?").run(fixture.userId);
    const lost = captureStatusPageSchema.parse(
      await (await fixture.request(`/bottle-capture-statuses?${query}`)).json(),
    );
    assert.deepEqual(lost.data, []);
  });

  await it("rejects invalid query bounds, malformed cursors and cross-view cursors", async (context) => {
    const fixture = setup(context);
    seedPages(fixture);
    const first = capturePageSchema.parse(
      await (await fixture.request("/bottle-captures?limit=1")).json(),
    );
    assert.ok(first.nextPageToken !== null);
    for (const suffix of [
      "limit=0",
      "limit=101",
      "limit=-1",
      "limit=1.5",
      "limit=no",
      "limit=",
      "view=invalid",
      "pageToken=",
      "pageToken=malformed",
      new URLSearchParams({ view: "all", pageToken: first.nextPageToken }).toString(),
    ]) {
      const response = await fixture.request(`/bottle-captures?${suffix}`);
      assert.equal(response.status, 400, suffix.slice(0, 100));
    }
    const otherActor = await app.request(
      `http://localhost/bottle-captures?${new URLSearchParams({ pageToken: first.nextPageToken })}`,
      { headers: { "x-dev-user": "different" } },
      fixture.bindings,
    );
    assert.equal(otherActor.status, 400);
    for (const suffix of [
      "",
      "?captureId=",
      `?${Array.from({ length: 101 }, () => "captureId=id").join("&")}`,
    ]) {
      assert.equal((await fixture.request(`/bottle-capture-statuses${suffix}`)).status, 400);
    }
  });

  await it("accepts its own continuation token for long opaque stored capture IDs", async (context) => {
    const fixture = setup(context);
    const id = ` legacy/${"蓮".repeat(3_000)} `;
    fixture.addCapture(id);
    fixture.addCapture(`${id}second`);
    const first = capturePageSchema.parse(
      await (await fixture.request("/bottle-captures?limit=1")).json(),
    );
    assert.equal(first.data[0]?.id, id);
    assert.ok(first.nextPageToken !== null);
    assert.ok(first.nextPageToken.length > 16_384);
    const second = capturePageSchema.parse(
      await (
        await fixture.request(
          `/bottle-captures?${new URLSearchParams({ limit: "1", pageToken: first.nextPageToken })}`,
        )
      ).json(),
    );
    assert.equal(second.data[0]?.id, `${id}second`);
    assert.equal(second.nextPageToken, null);
  });

  await it("preserves opaque site/location IDs when submitting capture multipart data", async (context) => {
    const fixture = setup(context);
    const siteId = " legacy/site ";
    const locationId = " legacy/location ";
    fixture.sqlite.prepare("INSERT INTO sites (id,name) VALUES (?,'Legacy')").run(siteId);
    fixture.sqlite
      .prepare("INSERT INTO site_memberships (site_id,user_id,role) VALUES (?,?,'owner')")
      .run(siteId, fixture.userId);
    fixture.sqlite
      .prepare("INSERT INTO storage_locations (id,site_id,name) VALUES (?,?,'Rack')")
      .run(locationId, siteId);
    const formData = new FormData();
    formData.set("siteId", siteId);
    formData.set("storageLocationId", locationId);
    formData.set("operationId", crypto.randomUUID());
    formData.set("quantity", "1");
    formData.append("images", new File(["photo"], "label.jpg", { type: "image/jpeg" }));
    const { bucket } = multipartBucket();
    const workflow = {
      async create({ id }: { readonly id: string }) {
        return { id };
      },
    };
    const response = await fixture.request(
      "/bottle-captures",
      { method: "POST", body: formData },
      {
        ...fixture.bindings,
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The route only calls create() on this Workflow test binding.
        BOTTLE_CAPTURE_WORKFLOW: workflow as unknown as Workflow,
        IMAGE_BUCKET: bucket,
      },
    );
    assert.equal(response.status, 201, await response.clone().text());
    const stored = fixture.sqlite
      .prepare("SELECT site_id,storage_location_id FROM bottle_captures")
      .get();
    assert.equal(stored?.["site_id"], siteId);
    assert.equal(stored?.["storage_location_id"], locationId);
  });

  await it("preserves an existing wine ID with surrounding spaces during reviewed import", async (context) => {
    const fixture = setup(context);
    const wineId = " legacy/wine 🍷 ";
    fixture.addCapture("capture", "needs_review");
    fixture.sqlite
      .prepare(
        "INSERT INTO wine_vintages (id,site_id,base_name,display_name,vintage_label) VALUES (?,'site','Reserve','Reserve','Unknown')",
      )
      .run(wineId);
    fixture.sqlite.exec(`
      INSERT INTO bottle_capture_runs (id,capture_id,status,extractor_version,prompt_version,schema_version,import_candidate_json)
        VALUES ('run','capture','needs_review','v1','v1','v1','{"wine":{},"bottle":{}}');
    `);
    const response = await fixture.request("/bottle-captures/capture/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wineVintageId: wineId }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(
      fixture.sqlite.prepare("SELECT wine_vintage_id FROM bottles").get()?.["wine_vintage_id"],
      wineId,
    );
  });
});
