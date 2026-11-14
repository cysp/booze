// oxlint-disable import/max-dependencies -- Exercise the actual browser payload against authorised catalogue routes and stored measurements.
import assert from "node:assert/strict";
import { it } from "node:test";
import { Hono } from "hono";
import { createD1Client } from "@chikachow/booze-db";
import { prepareWineVintage } from "./api/catalogue.ts";
import { problemResponseForError } from "./api/http.ts";
import { userIdForClerkUser } from "./api/ids.ts";
import type { Bindings } from "./api/types.ts";
import { asD1, migratedDatabase } from "./d1-support.ts";
import { bottleRoutes } from "./routes/bottles.ts";
import {
  bottleEditPayload,
  bottleFormSubmission,
  type BottleActionKind,
} from "../src/bottle-payload.ts";
import { formStateForItem, type FormState, type InventoryItem } from "../src/inventory-model.ts";
import { inventoryItemFixture } from "../src/test/catalogue-fixtures.ts";

function formEditPayload(kind: BottleActionKind, item: InventoryItem, form: FormState) {
  const submission = bottleFormSubmission(
    { kind, item },
    form,
    { awards: [], criticReviews: [] },
    "",
  );
  assert.ok(submission.kind !== "add");
  return bottleEditPayload(submission, item);
}

function setup() {
  const sqlite = migratedDatabase();
  const user = userIdForClerkUser("dev:tester");
  sqlite.prepare("INSERT INTO users (id, clerk_user_id) VALUES (?, 'dev:tester')").run(user);
  sqlite.exec("INSERT INTO sites (id, name) VALUES ('site', 'Home')");
  sqlite
    .prepare("INSERT INTO site_memberships (site_id, user_id, role) VALUES ('site', ?, 'owner')")
    .run(user);
  sqlite.exec(`INSERT INTO wineries (id, site_id, name) VALUES ('winery', 'site', 'Producer');
    INSERT INTO wine_vintages (id, site_id, winery_id, base_name, display_name, designation, vintage_label)
      VALUES ('wine', 'site', 'winery', 'Reserve', 'Producer Reserve', 'Reserve', 'Unknown');
    INSERT INTO bottles (id, site_id, wine_vintage_id) VALUES ('one', 'site', 'wine'), ('two', 'site', 'wine');
    INSERT INTO grape_varieties (id, name) VALUES ('grape', 'Shiraz');
    INSERT INTO wine_constituents (site_id, wine_vintage_id, grape_variety_id, percentage, blend_text)
      VALUES ('site', 'wine', 'grape', 100, 'Estate grown');`);
  const app = new Hono<{ Bindings: Bindings }>()
    .route("/", bottleRoutes)
    .onError(problemResponseForError);
  const d1 = asD1(sqlite);
  const item = inventoryItemFixture({
    id: "one",
    siteId: "site",
    wineVintageId: "wine",
    wineryId: "winery",
    wineryName: "Producer",
    brandName: null,
    designation: "Reserve",
    baseName: "Reserve",
    displayName: "Producer Reserve",
    vintageYear: null,
    vintageStatus: "unknown",
    vintageLabel: "Unknown",
    wineBottleCount: 2,
    storageLocationId: null,
    grapeVarieties: ["Shiraz"],
    region: null,
  });
  return {
    sqlite,
    item,
    d1,
    request: async (payload: unknown) => {
      return app.request(
        "http://localhost/bottles/one",
        {
          method: "PATCH",
          headers: { "content-type": "application/json", "x-dev-user": "tester" },
          body: JSON.stringify(payload),
        },
        { DB: d1 },
      );
    },
  };
}

await it("preserves unchanged grape measurements through frontend separate-wine payload", async () => {
  const { sqlite, item, request } = setup();
  const form = formStateForItem(item);
  form.vintageStatus = "year";
  form.vintageYear = "2024";
  const response = await request(formEditPayload("reassign", item, form));
  assert.equal(response.status, 200, await response.text());
  const row = sqlite
    .prepare(
      `SELECT c.percentage, c.blend_text FROM bottles b JOIN wine_constituents c ON c.wine_vintage_id = b.wine_vintage_id WHERE b.id = 'one'`,
    )
    .get();
  assert.deepEqual({ ...row }, { percentage: 100, blend_text: "Estate grown" });
  assert.equal(
    sqlite.prepare("SELECT wine_vintage_id FROM bottles WHERE id = 'two'").get()?.[
      "wine_vintage_id"
    ],
    "wine",
  );
  assert.equal(
    sqlite
      .prepare("SELECT percentage FROM wine_constituents WHERE wine_vintage_id = 'wine'")
      .get()?.["percentage"],
    100,
  );
});

await it("keeps the MCP base name coherent after designation correction", async () => {
  const { sqlite, item, request } = setup();
  const form = formStateForItem(item);
  form.designation = "Estate";
  const response = await request(formEditPayload("correct-wine", item, form));
  assert.equal(response.status, 200, await response.text());
  const row = sqlite
    .prepare(`SELECT base_name, designation, display_name FROM wine_vintages WHERE id = 'wine'`)
    .get();
  assert.equal(row?.["designation"], "Estate");
  assert.equal(row?.["base_name"], "Estate");
});

await it("keeps new grape measurements unknown and leaves the source composition intact", async () => {
  const { sqlite, item, request } = setup();
  const form = formStateForItem(item);
  form.grapeVarieties = ["Cabernet Sauvignon"];
  const response = await request(formEditPayload("reassign", item, form));
  assert.equal(response.status, 200, await response.text());
  const rows = sqlite
    .prepare(
      `SELECT g.name, c.percentage, c.blend_text FROM bottles b JOIN wine_constituents c ON c.wine_vintage_id = b.wine_vintage_id JOIN grape_varieties g ON g.id = c.grape_variety_id WHERE b.id = 'one'`,
    )
    .all();
  assert.deepEqual(
    rows.map((row) => ({ ...row })),
    [{ name: "Cabernet Sauvignon", percentage: null, blend_text: null }],
  );
  assert.equal(
    sqlite
      .prepare("SELECT percentage FROM wine_constituents WHERE wine_vintage_id = 'wine'")
      .get()?.["percentage"],
    100,
  );
});

await it("copies the source measurements at transaction time", async () => {
  const { sqlite, item, d1, request } = setup();
  const batch = d1.batch.bind(d1);
  d1.batch = async (statements) => {
    sqlite.exec(
      "UPDATE wine_constituents SET percentage = 90, blend_text = 'Corrected evidence' WHERE wine_vintage_id = 'wine'",
    );
    return batch(statements);
  };
  const form = formStateForItem(item);
  form.vintageStatus = "year";
  form.vintageYear = "2024";
  const response = await request(formEditPayload("reassign", item, form));
  assert.equal(response.status, 200, await response.text());
  const row = sqlite
    .prepare(
      `SELECT c.percentage, c.blend_text FROM bottles b JOIN wine_constituents c ON c.wine_vintage_id = b.wine_vintage_id WHERE b.id = 'one'`,
    )
    .get();
  assert.deepEqual({ ...row }, { percentage: 90, blend_text: "Corrected evidence" });
});

await it("does not inherit measurements from a source wine in another site", async () => {
  const { sqlite, d1 } = setup();
  sqlite.exec("INSERT INTO sites (id, name) VALUES ('other-site', 'Other cellar')");
  const database = createD1Client(d1);
  const prepared = await prepareWineVintage({
    database,
    siteId: "other-site",
    sourceWineVintageId: "wine",
    overwriteExisting: true,
    wine: { wineryName: "Other producer", grapeVarieties: ["Shiraz"] },
  });
  await database.batch(prepared.statements);
  const row = sqlite
    .prepare("SELECT percentage, blend_text FROM wine_constituents WHERE wine_vintage_id = ?")
    .get(prepared.wineVintageId);
  assert.deepEqual({ ...row }, { percentage: null, blend_text: null });
});

await it("preserves a legacy base name on unrelated correction but replaces it when designation is cleared", async () => {
  const { sqlite, item, request } = setup();
  sqlite.exec("UPDATE wine_vintages SET base_name = 'Historical name' WHERE id = 'wine'");
  const form = formStateForItem(item);
  form.wineNotes = "Corrected note";
  const noteResponse = await request(formEditPayload("correct-wine", item, form));
  assert.equal(noteResponse.status, 200, await noteResponse.text());
  assert.equal(
    sqlite.prepare("SELECT base_name FROM wine_vintages WHERE id = 'wine'").get()?.["base_name"],
    "Historical name",
  );
  form.designation = "";
  const clearResponse = await request(formEditPayload("correct-wine", item, form));
  assert.equal(clearResponse.status, 200, await clearResponse.text());
  const row = sqlite
    .prepare("SELECT base_name, designation FROM wine_vintages WHERE id = 'wine'")
    .get();
  assert.deepEqual({ ...row }, { base_name: "Producer Shiraz", designation: null });
});

await it("rejects a partial bottle clone when source grape membership changes before its batch", async () => {
  const { sqlite, d1, request } = setup();
  sqlite.exec("UPDATE wine_vintages SET display_name='Producer Reserve Shiraz' WHERE id='wine'");
  const batch = d1.batch.bind(d1);
  d1.batch = async (statements) => {
    sqlite.exec(
      "INSERT INTO grape_varieties (id,name) VALUES ('cabernet','Cabernet Sauvignon'); DELETE FROM wine_constituents WHERE wine_vintage_id='wine'; INSERT INTO wine_constituents (site_id,wine_vintage_id,grape_variety_id) VALUES ('site','wine','cabernet'); UPDATE wine_vintages SET display_name='Producer Reserve Cabernet Sauvignon' WHERE id='wine'",
    );
    return batch(statements);
  };
  const response = await request({
    wineEditScope: "bottle",
    expectedWineVintageId: "wine",
    wine: { vintageYear: 2024, vintageStatus: "year" },
  });
  assert.equal(response.status, 409, await response.text());
  assert.equal(
    sqlite.prepare("SELECT wine_vintage_id FROM bottles WHERE id='one'").get()?.["wine_vintage_id"],
    "wine",
  );
});
