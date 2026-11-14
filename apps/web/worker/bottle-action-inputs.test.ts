// oxlint-disable import/max-dependencies -- Exercises browser drafts through the real HTTP and database contracts.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Hono } from "hono";
import { bottleResourceSchema } from "../shared/catalogue-resources.ts";
import { bottleEditPayload, bottleFormSubmission } from "../src/bottle-payload.ts";
import {
  formStateForItem,
  initialFormState,
  inventoryItem,
  type InventoryItem,
} from "../src/inventory-model.ts";
import { problemResponseForError } from "./api/http.ts";
import { userIdForClerkUser } from "./api/ids.ts";
import type { Bindings } from "./api/types.ts";
import { asD1, migratedDatabase } from "./d1-support.ts";
import { bottleRoutes } from "./routes/bottles.ts";

const app = new Hono<{ Bindings: Bindings }>()
  .route("/api", bottleRoutes)
  .onError(problemResponseForError);

function setup() {
  const sqlite = migratedDatabase();
  const userId = userIdForClerkUser("dev:action-test");
  sqlite.prepare("INSERT INTO users(id,clerk_user_id) VALUES(?,'dev:action-test')").run(userId);
  sqlite.exec("INSERT INTO sites(id,name) VALUES('site','Cellar')");
  sqlite
    .prepare("INSERT INTO site_memberships(site_id,user_id,role) VALUES('site',?,'owner')")
    .run(userId);
  sqlite.exec(`
    INSERT INTO wineries(id,site_id,name) VALUES('winery','site','Original producer');
    INSERT INTO wine_vintages(id,site_id,winery_id,base_name,display_name,vintage_label,
      vintage_status,vintage_year,alcohol_percent,drink_from_year,drink_to_year,notes)
    VALUES('wine','site','winery','Original wine','Original wine','1700','year',1700,140,1710,1720,'Original wine note');
    INSERT INTO bottles(id,site_id,wine_vintage_id,volume_ml,notes)
    VALUES('bottle','site','wine',75000,'Original bottle note'),('other','site','wine',750,'Other bottle');
    INSERT INTO grape_varieties(id,name) VALUES('grape','Shiraz');
    INSERT INTO wine_constituents(site_id,wine_vintage_id,grape_variety_id,blend_text,percentage)
    VALUES('site','wine','grape','Old measured blend',100);
    INSERT INTO review_sources(id,site_id,name) VALUES('source','site','Original critic');
    INSERT INTO critic_reviews(id,site_id,wine_vintage_id,review_source_id,rating_text,notes)
    VALUES('review','site','wine','source','95 points','Original review');
    INSERT INTO wine_awards(id,site_id,wine_vintage_id,award_name,award_level,notes)
    VALUES('award','site','wine','Original award','Gold','Original award note');
    INSERT INTO label_extractions(id,bottle_id,wine_vintage_id,raw_text_json,extracted_fields_json)
    VALUES('extraction','bottle','wine','Original raw label','{"source":"original"}');
  `);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- These routes only use D1; no image or Workflow binding is invoked.
  const env = { DB: asD1(sqlite) } as Bindings;
  const headers = { "x-dev-user": "action-test", "Content-Type": "application/json" };
  async function read(id = "bottle"): Promise<InventoryItem> {
    const response = await app.request(`http://localhost/api/bottles/${id}`, { headers }, env);
    assert.equal(response.status, 200, await response.clone().text());
    const value: unknown = await response.json();
    assert.ok(typeof value === "object" && value !== null && "data" in value);
    return inventoryItem(bottleResourceSchema.parse(value.data));
  }
  async function patch(payload: unknown): Promise<void> {
    const response = await app.request(
      "http://localhost/api/bottles/bottle",
      { method: "PATCH", headers, body: JSON.stringify(payload) },
      env,
    );
    assert.equal(response.status, 200, await response.clone().text());
  }
  function evidence() {
    return ["critic_reviews", "wine_awards", "label_extractions", "wine_constituents"].map(
      (table) => sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    );
  }
  return { sqlite, read, patch, evidence };
}

await describe("focused browser actions across HTTP", async () => {
  await it("edits bottle notes without parsing or rewriting historical wine or size values", async () => {
    const { sqlite, read, patch, evidence } = setup();
    try {
      const item = await read();
      const wineBefore = sqlite.prepare("SELECT * FROM wine_vintages").all();
      const evidenceBefore = evidence();
      const submission = bottleFormSubmission(
        { kind: "edit-bottle", item },
        { ...formStateForItem(item), bottleNotes: "New bottle note" },
        {},
        "",
      );
      assert.equal(submission.kind, "edit-bottle");
      assert.notEqual(submission.kind, "add");
      await patch(bottleEditPayload(submission, item));
      const updated = await read();
      assert.equal(updated.bottleNotes, "New bottle note");
      assert.equal(updated.volumeMl, 75000);
      assert.equal(updated.alcoholPercent, 140);
      assert.equal(updated.vintageYear, 1700);
      assert.equal((await read("other")).bottleNotes, "Other bottle");
      assert.deepEqual(sqlite.prepare("SELECT * FROM wine_vintages").all(), wineBefore);
      assert.deepEqual(evidence(), evidenceBefore);
    } finally {
      sqlite.close();
    }
  });

  await it("corrects a shared note without submitting unchanged historical numeric facts or evidence", async () => {
    const { sqlite, read, patch, evidence } = setup();
    try {
      const item = await read();
      const evidenceBefore = evidence();
      const submission = bottleFormSubmission(
        { kind: "correct-wine", item },
        { ...formStateForItem(item), wineNotes: "Corrected shared note" },
        {},
        "",
      );
      assert.equal(submission.kind, "correct-wine");
      assert.notEqual(submission.kind, "add");
      await patch(bottleEditPayload(submission, item));
      for (const id of ["bottle", "other"]) {
        const updated = await read(id);
        assert.equal(updated.wineNotes, "Corrected shared note");
        assert.equal(updated.alcoholPercent, 140);
        assert.equal(updated.vintageYear, 1700);
        assert.equal(updated.drinkFromYear, 1710);
        assert.equal(updated.drinkToYear, 1720);
      }
      assert.deepEqual(evidence(), evidenceBefore);
    } finally {
      sqlite.close();
    }
  });

  await it("reassigns to a new wine with unknown numeric facts and preserves the original wine and evidence", async () => {
    const { sqlite, read, patch, evidence } = setup();
    try {
      const item = await read();
      const oldWine = sqlite.prepare("SELECT * FROM wine_vintages WHERE id='wine'").get();
      const evidenceBefore = evidence();
      const submission = bottleFormSubmission(
        { kind: "reassign", item },
        {
          ...initialFormState,
          wineryName: "New producer",
          designation: "Different wine",
          bottleVolumeMl: "750",
        },
        {},
        "",
      );
      assert.equal(submission.kind, "reassign");
      assert.notEqual(submission.kind, "add");
      await patch(bottleEditPayload(submission, item));
      const updated = await read();
      assert.notEqual(updated.wineVintageId, item.wineVintageId);
      assert.equal(updated.wineryName, "New producer");
      assert.equal(updated.alcoholPercent, null);
      assert.equal(updated.drinkFromYear, null);
      assert.equal(updated.drinkToYear, null);
      assert.equal(updated.vintageYear, null);
      assert.equal(updated.vintageStatus, "unknown");
      assert.deepEqual(updated.grapeVarieties, []);
      assert.deepEqual(updated.criticReviews, []);
      assert.deepEqual(updated.awards, []);
      assert.equal(updated.volumeMl, 75000);
      assert.equal(updated.bottleNotes, "Original bottle note");
      assert.equal((await read("other")).wineVintageId, item.wineVintageId);
      assert.deepEqual(
        sqlite.prepare("SELECT * FROM wine_vintages WHERE id='wine'").get(),
        oldWine,
      );
      assert.deepEqual(evidence(), evidenceBefore);
    } finally {
      sqlite.close();
    }
  });
});
