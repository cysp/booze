// oxlint-disable import/max-dependencies -- Check actual database projections against shared browser response contracts.
import assert from "node:assert/strict";
import { it } from "node:test";
import { createD1Client } from "@chikachow/booze-db";
import { Hono } from "hono";
import { z } from "zod";
import {
  bottleResourceSchema,
  siteResourceSchema,
  storageLocationResourceSchema,
} from "../shared/catalogue-resources.ts";
import { captureResourceSchema } from "../shared/capture-resources.ts";
import { getBottle } from "./api/inventory.ts";
import { userIdForClerkUser } from "./api/ids.ts";
import { problemResponseForError } from "./api/http.ts";
import type { Bindings } from "./api/types.ts";
import { getBottleCapture } from "./capture-store.ts";
import { asD1, migratedDatabase } from "./d1-support.ts";
import { siteRoutes } from "./routes/sites.ts";
import { storageLocationRoutes } from "./routes/storage-locations.ts";

function setup() {
  const sqlite = migratedDatabase();
  const userId = userIdForClerkUser("dev:tester");
  sqlite.prepare("INSERT INTO users(id,clerk_user_id) VALUES (?, 'dev:tester')").run(userId);
  sqlite.exec(`INSERT INTO sites(id,name) VALUES ('site','Cellar');
    INSERT INTO wine_vintages(id,site_id,base_name,display_name,alcohol_percent,vintage_label) VALUES ('wine','site','Wine','Wine',14.5,'Unknown');
    INSERT INTO bottles(id,site_id,wine_vintage_id,volume_ml) VALUES ('bottle','site','wine',75000);
    INSERT INTO storage_locations(id,site_id,parent_id,name) VALUES ('rack','site',NULL,'Rack / with slash'),('shelf','site','rack','Shelf');`);
  sqlite
    .prepare("INSERT INTO site_memberships(site_id,user_id,role) VALUES ('site',?,'owner')")
    .run(userId);
  sqlite
    .prepare(
      "INSERT INTO bottle_captures(id,site_id,user_id,status) VALUES ('capture','site',?,'needs_review')",
    )
    .run(userId);
  const d1 = asD1(sqlite);
  return { sqlite, userId, d1, database: createD1Client(d1) };
}

await it("preserves exact grape array elements and historical numeric values in shared bottle resources", async (context) => {
  const fixture = setup();
  context.after(() => {
    fixture.sqlite.close();
  });
  const names = ["Grenache (Garnacha, Alicante)", 'Muscat "blanc"', "蓮🍷"];
  for (const [index, name] of names.entries()) {
    const id = `grape-${index}`;
    fixture.sqlite.prepare("INSERT INTO grape_varieties(id,name) VALUES (?,?)").run(id, name);
    fixture.sqlite
      .prepare(
        "INSERT INTO wine_constituents(site_id,wine_vintage_id,grape_variety_id) VALUES ('site','wine',?)",
      )
      .run(id);
  }
  const bottle = bottleResourceSchema.parse(await getBottle({ ...fixture, bottleId: "bottle" }));
  assert.deepEqual(new Set(bottle.grapeVarieties), new Set(names));
  assert.equal(bottle.volumeMl, 75000, "Historical values stay visible for deliberate correction");
  assert.equal(bottle.alcoholPercent, 14.5);
  assert.equal(fixture.sqlite.prepare("SELECT volume_ml FROM bottles").get()?.["volume_ml"], 75000);
});

await it("serves canonical site, leaf location and capture resources without presentation parsing", async (context) => {
  const fixture = setup();
  context.after(() => {
    fixture.sqlite.close();
  });
  const app = new Hono<{ Bindings: Bindings }>()
    .route("/", siteRoutes)
    .route("/", storageLocationRoutes)
    .onError(problemResponseForError);
  const get = async (path: string) =>
    app.request(
      `http://localhost${path}`,
      { headers: { "x-dev-user": "tester" } },
      { DB: fixture.d1 },
    );
  const sites = z
    .object({ data: siteResourceSchema.array() })
    .parse(await (await get("/sites")).json());
  assert.deepEqual(
    sites.data.map((site) => [site.id, site.name, site.role]),
    [["site", "Cellar", "owner"]],
  );
  const locations = z
    .object({ data: storageLocationResourceSchema.array() })
    .parse(await (await get("/storage-locations")).json());
  assert.deepEqual(
    locations.data.map((location) => [location.id, location.parentId, location.name]),
    [
      ["rack", null, "Rack / with slash"],
      ["shelf", "rack", "Shelf"],
    ],
  );
  const capture = captureResourceSchema.parse(
    await getBottleCapture({ ...fixture, captureId: "capture" }),
  );
  assert.equal(capture.workflowInstanceId, null);
  assert.deepEqual(capture.images, []);
  assert.equal(capture.status, "needs_review");
  const captureId = "capture / #?";
  const imageId = "image / #?";
  fixture.sqlite.prepare("UPDATE bottle_captures SET id=? WHERE id='capture'").run(captureId);
  fixture.sqlite
    .prepare(
      "INSERT INTO image_assets(id,site_id,sha256,r2_key,content_type,size_bytes,uploaded_by_user_id) VALUES (?,'site','digest','legacy/original','image/jpeg',3,?)",
    )
    .run(imageId, fixture.userId);
  fixture.sqlite
    .prepare(
      "INSERT INTO bottle_capture_images(capture_id,image_asset_id,sort_order) VALUES (?,?,0)",
    )
    .run(captureId, imageId);
  const withImage = captureResourceSchema.parse(await getBottleCapture({ ...fixture, captureId }));
  assert.equal(
    withImage?.images[0]?.imageUrl,
    `/api/bottle-captures/${encodeURIComponent(captureId)}/images/${encodeURIComponent(imageId)}`,
  );
  fixture.sqlite.exec("UPDATE site_memberships SET role='invalid-legacy-role'");
  assert.equal((await get("/sites")).status, 500);
});

await it("reads historical saved review values without applying new-entry limits or altering stored evidence", async (context) => {
  const fixture = setup();
  context.after(() => {
    fixture.sqlite.close();
  });
  const candidate = {
    wine: {
      wineryName: "Winery",
      designation: null,
      vintageYear: 1700,
      alcoholPercent: 140,
      country: null,
    },
    bottle: { volumeMl: 75000 },
  };
  const stored = JSON.stringify(candidate);
  fixture.sqlite
    .prepare("UPDATE bottle_captures SET review_candidate_json=? WHERE id='capture'")
    .run(stored);
  const capture = captureResourceSchema.parse(
    await getBottleCapture({ ...fixture, captureId: "capture" }),
  );
  assert.deepEqual(capture.reviewCandidate, candidate);
  assert.equal(
    fixture.sqlite
      .prepare("SELECT review_candidate_json FROM bottle_captures WHERE id='capture'")
      .get()?.["review_candidate_json"],
    stored,
  );
});
