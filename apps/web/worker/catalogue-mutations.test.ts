// oxlint-disable import/max-dependencies -- Integration cases combine database, route, authentication, and response-validation boundaries.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

import { createD1Client } from "@chikachow/booze-db";
import { Hono } from "hono";

import { upsertSite } from "./api/auth.ts";
import { createBottleStatements } from "./api/catalogue.ts";
import { problemResponseForError } from "./api/http.ts";
import { userIdForClerkUser } from "./api/ids.ts";
import type { Bindings } from "./api/types.ts";
import { asD1, migratedDatabase } from "./d1-support.ts";
import { bottleRoutes } from "./routes/bottles.ts";

const app = new Hono<{ Bindings: Bindings }>()
  .route("/", bottleRoutes)
  .onError(problemResponseForError);

const siteId = "site_user_abcdefghijklmnopqrstuvwxyz_long_site_identifier";
const wine = {
  wineryName: "Estate",
  designation: "Reserve",
  baseName: "Historic name",
  displayName: "Reserve red",
  vintageYear: 2020,
};

await describe("catalogue mutation preservation", async () => {
  await it("creates distinct unnamed wines without inventing a designation or NV", async () => {
    const db = setup();
    const first = await create(db, {
      wine: {
        wineryName: "RIKARD Wines",
        brandName: "RIKARD",
        grapeVarieties: ["Shiraz"],
        vintageYear: 2022,
      },
    });
    const second = await create(db, {
      wine: {
        wineryName: "RIKARD Wines",
        brandName: "RIKARD",
        grapeVarieties: ["Shiraz"],
        vintageYear: 2022,
      },
    });
    assert.notEqual(vintageIdForBottle(db, first), vintageIdForBottle(db, second));
    const unknown = await create(db, {
      wine: { wineryName: "RIKARD", grapeVarieties: ["Shiraz"] },
    });
    const nv = await create(db, {
      wine: { wineryName: "RIKARD", grapeVarieties: ["Shiraz"], vintageStatus: "non_vintage" },
    });
    const rows = db
      .prepare(
        "SELECT id, designation, display_name, vintage_status, vintage_label FROM wine_vintages",
      )
      .all();
    assert.ok(rows.every((row) => row["designation"] === null));
    assert.equal(
      rows.find((row) => row["id"] === vintageIdForBottle(db, first))?.["display_name"],
      "RIKARD Shiraz",
    );
    assert.equal(
      rows.find((row) => row["id"] === vintageIdForBottle(db, unknown))?.["vintage_label"],
      "Unknown",
    );
    assert.equal(
      rows.find((row) => row["id"] === vintageIdForBottle(db, nv))?.["vintage_label"],
      "NV",
    );
  });

  await it("requires explicit unidentified saving and returns stock without a fictional producer", async () => {
    const db = setup();
    const denied = await request(db, "POST", "/bottles", { siteId, wine: { wineryName: "" } });
    assert.equal(denied.status, 400);
    const id = await create(db, { wine: { wineryName: "" }, allowUnidentified: true });
    assert.equal(count(db, "wineries"), 0);
    const response = await app.request(
      "http://localhost/bottles",
      { headers: { "x-dev-user": "tester" } },
      { DB: asD1(db) },
    );
    const body = z
      .object({
        data: z.array(
          z.object({
            id: z.string(),
            wineryId: z.string().nullable(),
            displayName: z.string(),
            wineBottleCount: z.number(),
          }),
        ),
      })
      .parse(await response.json());
    assert.equal(response.status, 200);
    assert.equal(body.data[0]?.id, id);
    assert.equal(body.data[0]?.wineryId, null);
    assert.equal(body.data[0]?.displayName, "Unidentified wine");
    assert.equal(body.data[0]?.wineBottleCount, 1);
  });

  await it("requires explicit scope and keeps shared correction on the same wine ID", async () => {
    const db = setup();
    const id = await create(db, { wine, quantity: 2 });
    const original = vintageIdForBottle(db, id);
    const denied = await request(db, "PATCH", `/bottles/${id}`, { wine: { vintageYear: 2021 } });
    assert.equal(denied.status, 400);
    const changed = await editRequest(db, "PATCH", `/bottles/${id}`, {
      wine: { vintageYear: 2021, designation: "Corrected" },
    });
    assert.equal(changed.status, 200);
    assert.equal(vintageIdForBottle(db, id), original);
    assert.equal(count(db, "wine_vintages"), 1);
    assert.equal(
      db.prepare("SELECT count(*) AS count FROM bottles WHERE wine_vintage_id = ?").get(original)?.[
        "count"
      ],
      2,
    );
    assert.equal(
      db.prepare("SELECT vintage_year FROM wine_vintages WHERE id = ?").get(original)?.[
        "vintage_year"
      ],
      2021,
    );
  });

  await it("rejects stale shared bottle counts atomically", async () => {
    const db = setup();
    const id = await create(db, { wine });
    const wineId = vintageIdForBottle(db, id);
    const response = await editRequest(
      db,
      "PATCH",
      `/bottles/${id}`,
      { wine: { notes: "Must not save" }, bottle: { notes: "Must not save" } },
      () => {
        db.prepare(
          "INSERT INTO bottles(id, site_id, wine_vintage_id) VALUES ('concurrent', ?, ?)",
        ).run(siteId, wineId);
      },
    );
    assert.equal(response.status, 409);
    assert.equal(db.prepare("SELECT notes FROM wine_vintages").get()?.["notes"], null);
    assert.equal(db.prepare("SELECT notes FROM bottles WHERE id = ?").get(id)?.["notes"], null);
  });

  await it("resolves site names by current authorised names and preserves legacy IDs", async () => {
    const db = setup();
    const database = createD1Client(asD1(db));
    const userId = userIdForClerkUser("dev:tester");
    assert.equal((await upsertSite({ database, userId, site: "Cellar" })).siteId, siteId);
    db.prepare("UPDATE sites SET name = 'Renamed' WHERE id = ?").run(siteId);
    const recreated = await upsertSite({ database, userId, site: "Cellar" });
    assert.notEqual(recreated.siteId, siteId);
    assert.equal((await upsertSite({ database, userId, site: "Renamed" })).siteId, siteId);
    const first = await upsertSite({ database, userId, site: "a".repeat(79) + "1" });
    const second = await upsertSite({ database, userId, site: "a".repeat(79) + "2" });
    assert.notEqual(first.siteId, second.siteId);
    db.prepare("UPDATE sites SET name = 'Renamed' WHERE id = ?").run(recreated.siteId);
    await assert.rejects(
      upsertSite({ database, userId, site: "Renamed" }),
      (error: unknown) =>
        typeof error === "object" && error !== null && "status" in error && error.status === 409,
    );
  });

  await it("preserves existing wine facts and constituent details when adding more bottles", async () => {
    const db = setup();
    const first = await create(db, {
      wine: {
        ...wine,
        notes: "Cellar notes",
        drinkFromYear: 2025,
        drinkToYear: 2030,
        alcoholPercent: 13.5,
        grapeVarieties: ["Shiraz"],
      },
    });
    db.exec("UPDATE wine_constituents SET percentage = 100, blend_text = 'Estate grown'");
    await create(db, {
      wineVintageId: vintageIdForBottle(db, first),
    });
    await create(db, { wineVintageId: vintageIdForBottle(db, first) });
    const stored = db
      .prepare("SELECT notes, drink_from_year, drink_to_year, alcohol_percent FROM wine_vintages")
      .get();
    assert.deepEqual(
      { ...stored },
      { notes: "Cellar notes", drink_from_year: 2025, drink_to_year: 2030, alcohol_percent: 13.5 },
    );
    assert.equal(count(db, "bottles"), 3);
    assert.equal(count(db, "wine_vintages"), 1);
    assert.equal(count(db, "wine_constituents"), 1);
    assert.equal(
      db
        .prepare("SELECT percentage FROM wine_constituents WHERE blend_text = 'Estate grown'")
        .get()?.["percentage"],
      100,
    );
  });

  await it("supports partial wine edits and explicit clearing without renaming the vintage", async () => {
    const db = setup();
    const id = await create(db, {
      wine: {
        ...wine,
        notes: "Keep",
        addressQualification: "Old address",
        alcoholPercent: 14,
        grapeVarieties: ["Shiraz"],
      },
    });
    const vintageId = db.prepare("SELECT wine_vintage_id FROM bottles WHERE id = ?").get(id)?.[
      "wine_vintage_id"
    ];
    const response = await editRequest(db, "PATCH", `/bottles/${id}`, {
      wine: { addressQualification: "New address", alcoholPercent: null },
    });
    assert.equal(response.status, 200);
    const stored = db
      .prepare(
        "SELECT id, base_name, designation, display_name, notes, address_qualification, alcohol_percent FROM wine_vintages",
      )
      .get();
    assert.deepEqual(
      { ...stored },
      {
        id: vintageId,
        base_name: "Historic name",
        designation: "Reserve",
        display_name: "Reserve red",
        notes: "Keep",
        address_qualification: "New address",
        alcohol_percent: null,
      },
    );
    assert.equal(count(db, "wine_constituents"), 1);
    const clear = await editRequest(db, "PATCH", `/bottles/${id}`, {
      wine: { grapeVarieties: [], notes: "" },
    });
    assert.equal(clear.status, 200);
    assert.equal(count(db, "wine_constituents"), 0);
    assert.equal(db.prepare("SELECT notes FROM wine_vintages").get()?.["notes"], null);
  });

  await it("never changes an existing drinking window when explicitly adding bottles", async () => {
    const db = setup();
    const first = await create(db, { wine: { ...wine, drinkFromYear: 2030 } });
    await create(db, {
      wineVintageId: vintageIdForBottle(db, first),
      wine: { ...wine, drinkFromYear: 2020, drinkToYear: 2025 },
    });
    assert.deepEqual(
      { ...db.prepare("SELECT drink_from_year, drink_to_year FROM wine_vintages").get() },
      { drink_from_year: 2030, drink_to_year: null },
    );
    assert.equal(count(db, "wine_vintages"), 1);
  });

  await it("requires a complete drinking-window edit and leaves rejected mutations unchanged", async () => {
    const db = setup();
    const id = await create(db, { wine: { ...wine, drinkFromYear: 2020, drinkToYear: 2030 } });
    for (const window of [
      { drinkFromYear: 2028 },
      { drinkToYear: 2025 },
      { drinkFromYear: null },
      { drinkFromYear: 2035, drinkToYear: 2030 },
    ]) {
      const response = await editRequest(db, "PATCH", `/bottles/${id}`, {
        status: "consumed",
        wine: window,
      });
      assert.equal(response.status, 400, JSON.stringify(window));
      assert.equal(
        db.prepare("SELECT status FROM bottles WHERE id = ?").get(id)?.["status"],
        "in_stock",
      );
    }
    const response = await editRequest(
      db,
      "PATCH",
      `/bottles/${id}`,
      {
        wine: { drinkFromYear: 2028, drinkToYear: null },
      },
      () => {
        db.exec("UPDATE wine_vintages SET drink_from_year = 2020, drink_to_year = 2025");
      },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(
      { ...db.prepare("SELECT drink_from_year, drink_to_year FROM wine_vintages").get() },
      { drink_from_year: 2028, drink_to_year: null },
    );
  });

  await it("preserves the existing target blend when a bottle changes vintage", async () => {
    const db = setup();
    const id = await create(db, { wine: { ...wine, grapeVarieties: ["Shiraz"] } });
    const target = await create(db, {
      wine: { ...wine, vintageYear: 2021, grapeVarieties: ["Cabernet"] },
    });
    db.exec("UPDATE wine_constituents SET percentage = 100, blend_text = 'Original blend'");
    const before = db.prepare("SELECT * FROM wine_constituents ORDER BY wine_vintage_id").all();
    const response = await editRequest(db, "PATCH", `/bottles/${id}`, {
      wineEditScope: "bottle",
      wineVintageId: vintageIdForBottle(db, target),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(
      db.prepare("SELECT * FROM wine_constituents ORDER BY wine_vintage_id").all(),
      before,
    );
    assert.equal(count(db, "wine_vintages"), 2);
    assert.equal(
      db.prepare("SELECT count(DISTINCT wine_vintage_id) AS count FROM bottles").get()?.["count"],
      1,
    );
  });

  await it("preserves retained grape measurements while adding or removing other grapes", async () => {
    const db = setup();
    const id = await create(db, { wine: { ...wine, grapeVarieties: ["Shiraz", "Merlot"] } });
    db.exec(
      "UPDATE wine_constituents SET percentage = 80, blend_text = 'Old vines' WHERE grape_variety_id = (SELECT id FROM grape_varieties WHERE name = 'Shiraz')",
    );
    const response = await editRequest(db, "PATCH", `/bottles/${id}`, {
      wine: { grapeVarieties: ["Shiraz", "Cabernet"] },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(
      db
        .prepare(
          "SELECT g.name, c.percentage, c.blend_text FROM wine_constituents c JOIN grape_varieties g ON g.id = c.grape_variety_id ORDER BY g.name",
        )
        .all()
        .map((row) => ({ ...row })),
      [
        { name: "Cabernet", percentage: null, blend_text: null },
        { name: "Shiraz", percentage: 80, blend_text: "Old vines" },
      ],
    );
  });

  await it("preserves nullable designation and constituent measurements on unrelated edits and reassignment", async () => {
    const db = setup();
    const id = await create(db, { wine: { ...wine, grapeVarieties: ["Shiraz"], notes: "Keep" } });
    db.exec(
      "UPDATE wine_vintages SET designation = NULL; UPDATE wine_constituents SET percentage = 100, blend_text = 'Old vines'",
    );
    const edit = await editRequest(db, "PATCH", `/bottles/${id}`, { wine: { notes: "Updated" } });
    assert.equal(edit.status, 200);
    assert.equal(db.prepare("SELECT designation FROM wine_vintages").get()?.["designation"], null);
    const move = await editRequest(db, "PATCH", `/bottles/${id}`, {
      wineEditScope: "bottle",
      wine: { vintageYear: 2021 },
    });
    assert.equal(move.status, 200);
    assert.equal(count(db, "wine_vintages"), 2);
    assert.equal(count(db, "wine_constituents"), 2);
    const stored = db
      .prepare(
        "SELECT v.notes, v.designation, c.percentage, c.blend_text FROM bottles b JOIN wine_vintages v ON b.wine_vintage_id = v.id JOIN wine_constituents c ON c.wine_vintage_id = v.id WHERE b.id = ?",
      )
      .get(id);
    assert.deepEqual(
      { ...stored },
      { notes: "Updated", designation: null, percentage: 100, blend_text: "Old vines" },
    );
  });

  await it("does not reverse a concurrent wine reassignment during unrelated bottle updates", async () => {
    for (const patch of [
      { bottle: { notes: "Updated bottle note" } },
      { status: "consumed" },
      { storageLocationId: "location-1", positionHint: "A2" },
      { wine: { notes: "Updated wine note" } },
    ]) {
      const db = setup();
      const id = await create(db, { wine });
      const other = await create(db, { wine: { ...wine, vintageYear: 2021 } });
      const otherVintageId = db
        .prepare("SELECT wine_vintage_id FROM bottles WHERE id = ?")
        .get(other)?.["wine_vintage_id"];
      assert.ok(typeof otherVintageId === "string");
      const response = await editRequest(db, "PATCH", `/bottles/${id}`, patch, () => {
        db.prepare("UPDATE bottles SET wine_vintage_id = ? WHERE id = ?").run(otherVintageId, id);
      });
      assert.equal(response.status, "wine" in patch ? 409 : 200);
      assert.equal(
        db.prepare("SELECT wine_vintage_id FROM bottles WHERE id = ?").get(id)?.["wine_vintage_id"],
        otherVintageId,
        JSON.stringify(patch),
      );
    }
  });

  await it("preserves reviews and awards when explicitly adding stock to an existing wine", async () => {
    const db = setup();
    const first = await create(db, {
      wine,
      criticReviews: [{ reviewSourceName: "Critic", ratingText: "95 points" }],
      awards: [{ awardName: "Show", awardLevel: "Gold" }],
    });
    await create(db, { wineVintageId: vintageIdForBottle(db, first) });
    assert.equal(count(db, "critic_reviews"), 1);
    assert.equal(count(db, "wine_awards"), 1);
    assert.equal(count(db, "wine_vintages"), 1);
    assert.equal(count(db, "bottles"), 2);
    assert.equal(
      db.prepare("SELECT rating_text FROM critic_reviews").get()?.["rating_text"],
      "95 points",
    );
    const rejected = await request(db, "POST", "/bottles", {
      siteId,
      wineVintageId: vintageIdForBottle(db, first),
      awards: [],
    });
    assert.equal(rejected.status, 400);
    assert.equal(count(db, "wine_awards"), 1);
  });

  await it("validates the destination before changing bottle or wine facts", async () => {
    const db = setup();
    const id = await create(db, { wine: { ...wine, notes: "Keep" } });
    const response = await editRequest(db, "PATCH", `/bottles/${id}`, {
      status: "consumed",
      wine: { notes: "Changed" },
      storageLocationId: "missing-location",
    });
    assert.equal(response.status, 400);
    assert.equal(db.prepare("SELECT status FROM bottles").get()?.["status"], "in_stock");
    assert.equal(db.prepare("SELECT notes FROM wine_vintages").get()?.["notes"], "Keep");
  });

  await it("rolls back wine, bottles, locations and evidence if the final award write fails", async () => {
    const db = setup();
    db.exec(
      "CREATE TRIGGER fail_award BEFORE INSERT ON wine_awards BEGIN SELECT RAISE(ABORT, 'injected award failure'); END",
    );
    const response = await request(db, "POST", "/bottles", {
      siteId,
      storageLocationId: "location-1",
      quantity: 24,
      wine: { ...wine, grapeVarieties: ["Shiraz"] },
      labelExtraction: { extractedFieldsJson: "{}" },
      criticReviews: [{ reviewSourceName: "Independent critic", ratingText: "95 points" }],
      awards: [{ awardName: "Wine show", awardLevel: "Gold" }],
    });
    assert.equal(response.status, 500);
    for (const table of [
      "bottles",
      "bottle_locations",
      "wine_vintages",
      "wineries",
      "wine_constituents",
      "label_extractions",
      "critic_reviews",
      "wine_awards",
    ])
      assert.equal(count(db, table), 0, table);
  });

  await it("preserves the original location when a replacement insert fails", async () => {
    const db = setup();
    const id = await create(db, { wine, storageLocationId: "location-1" });
    db.prepare(
      "INSERT INTO storage_locations (id, site_id, name) VALUES ('location-2', ?, 'Rack 2')",
    ).run(siteId);
    db.exec(
      "CREATE TRIGGER fail_move BEFORE INSERT ON bottle_locations WHEN NEW.storage_location_id = 'location-2' BEGIN SELECT RAISE(ABORT, 'injected move failure'); END",
    );
    const response = await editRequest(db, "PATCH", `/bottles/${id}`, {
      storageLocationId: "location-2",
      wine: { notes: "Should roll back" },
    });
    assert.equal(response.status, 500);
    assert.equal(
      db.prepare("SELECT storage_location_id FROM bottle_locations").get()?.["storage_location_id"],
      "location-1",
    );
    assert.equal(db.prepare("SELECT notes FROM wine_vintages").get()?.["notes"], null);
  });

  await it("keeps distinct awards for long site and vintage IDs and preserves IDs on edit", async () => {
    const db = setup();
    const awards = [
      { awardName: "First show", awardLevel: "Gold", awardYear: 2024 },
      { awardName: "Second show", awardLevel: "Silver", awardYear: 2025 },
    ];
    const id = await create(db, { wine, awards });
    const before = db.prepare("SELECT id, award_name FROM wine_awards ORDER BY award_name").all();
    assert.equal(before.length, 2);
    const response = await editRequest(db, "PATCH", `/bottles/${id}`, {
      awards: awards.map((award) => ({ ...award, notes: "Updated" })),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(
      db.prepare("SELECT id, award_name FROM wine_awards ORDER BY award_name").all(),
      before,
    );
  });

  await it("rejects unavailable review sources before any bottle mutation", async () => {
    const db = setup();
    const id = await create(db, { wine });
    const response = await editRequest(db, "PATCH", `/bottles/${id}`, {
      status: "consumed",
      criticReviews: [{ reviewSourceId: "unavailable", ratingText: "95 points" }],
    });
    assert.equal(response.status, 400);
    assert.equal(db.prepare("SELECT status FROM bottles").get()?.["status"], "in_stock");
  });

  await it("clears award points while retaining the award identity and provenance", async () => {
    const db = setup();
    const award = { awardName: "Wine show", awardLevel: "Gold", provenance: "2024 results" };
    const id = await create(db, { wine, awards: [{ ...award, points: 95 }] });
    const before = db.prepare("SELECT id FROM wine_awards").get()?.["id"];
    const response = await editRequest(db, "PATCH", `/bottles/${id}`, { awards: [award] });
    assert.equal(response.status, 200);
    assert.deepEqual(
      { ...db.prepare("SELECT id, points, provenance FROM wine_awards").get() },
      { id: before, points: null, provenance: "2024 results" },
    );
  });

  await it("uses bounded statements for 24 physical bottles", () => {
    const db = setup();
    const result = createBottleStatements({
      database: createD1Client(asD1(db)),
      siteId,
      wineVintageId: "wine",
      storageLocationId: "location-1",
      positionHint: "1",
      quantity: 24,
      bottle: {},
    });
    assert.equal(result.bottleIds.length, 24);
    assert.equal(new Set(result.bottleIds).size, 24);
    assert.equal(result.statements.length, 48);
    for (const statement of result.statements) {
      assert.ok("toSQL" in statement && typeof statement.toSQL === "function");
      // oxlint-disable-next-line typescript/no-unsafe-call -- The preceding guard verifies this query exposes its SQL compiler.
      const query: unknown = statement.toSQL();
      assert.ok(
        typeof query === "object" &&
          query !== null &&
          "params" in query &&
          Array.isArray(query.params),
      );
      assert.ok(query.params.length <= 100);
    }
  });
});

function setup(): DatabaseSync {
  const db = migratedDatabase();
  db.prepare("INSERT INTO users (id, clerk_user_id) VALUES (?, 'dev:tester')").run(
    userIdForClerkUser("dev:tester"),
  );
  db.prepare("INSERT INTO sites (id, name) VALUES (?, 'Cellar')").run(siteId);
  db.prepare("INSERT INTO site_memberships (site_id, user_id, role) VALUES (?, ?, 'owner')").run(
    siteId,
    userIdForClerkUser("dev:tester"),
  );
  db.prepare(
    "INSERT INTO storage_locations (id, site_id, name) VALUES ('location-1', ?, 'Rack')",
  ).run(siteId);
  return db;
}

async function create(db: DatabaseSync, payload: Record<string, unknown>): Promise<string> {
  const response = await request(db, "POST", "/bottles", { siteId, ...payload });
  assert.equal(response.status, 201, await response.clone().text());
  const body: unknown = await response.json();
  assert.ok(
    typeof body === "object" &&
      body !== null &&
      "data" in body &&
      typeof body.data === "object" &&
      body.data !== null &&
      "bottleIds" in body.data &&
      Array.isArray(body.data.bottleIds),
  );
  return String(body.data.bottleIds[0]);
}

async function request(
  db: DatabaseSync,
  method: string,
  path: string,
  payload: Record<string, unknown>,
  beforeBatch?: () => void,
): Promise<Response> {
  const database = asD1(db);
  const batch = database.batch.bind(database);
  database.batch = async <T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
    beforeBatch?.();
    return batch<T>(statements);
  };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Route tests supply only the database binding used by these handlers.
  const bindings = { DB: database } as Bindings;
  return app.request(
    `http://localhost${path}`,
    {
      method,
      headers: { "content-type": "application/json", "x-dev-user": "tester" },
      body: JSON.stringify({
        ...(method === "POST" && path === "/bottles" ? { operationId: crypto.randomUUID() } : {}),
        ...payload,
      }),
    },
    bindings,
  );
}

function count(db: DatabaseSync, table: string): number {
  return Number(db.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.["count"]);
}

function vintageIdForBottle(db: DatabaseSync, id: string): string {
  const value = db.prepare("SELECT wine_vintage_id FROM bottles WHERE id = ?").get(id)?.[
    "wine_vintage_id"
  ];
  assert.equal(typeof value, "string");
  return String(value);
}

// These regression scenarios explicitly correct shared facts unless they
// specify reassignment. Tests for omitted scope use request() directly.
async function editRequest(
  db: DatabaseSync,
  method: string,
  path: string,
  payload: Record<string, unknown>,
  beforeBatch?: () => void,
) {
  const wineVintageId = vintageIdForBottle(db, path.split("/").at(-1) ?? "");
  const affected = db
    .prepare("SELECT count(*) AS count FROM bottles WHERE wine_vintage_id = ?")
    .get(wineVintageId)?.["count"];
  return request(
    db,
    method,
    path,
    {
      ...(payload["wine"] !== undefined ||
      payload["wineVintageId"] !== undefined ||
      payload["criticReviews"] !== undefined ||
      payload["awards"] !== undefined
        ? {
            wineEditScope: "shared",
            expectedWineVintageId: wineVintageId,
            expectedAffectedBottleCount: affected,
          }
        : {}),
      ...payload,
    },
    beforeBatch,
  );
}
