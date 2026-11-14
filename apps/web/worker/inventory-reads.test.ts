// oxlint-disable import/max-dependencies -- Exercise actual HTTP reads, SQL, and canonical response contracts together.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createD1Client, wineVintages } from "@chikachow/booze-db";
import { Hono } from "hono";
import { bottleResourceSchema } from "../shared/catalogue-resources.ts";
import { catalogueSummarySchema } from "../shared/catalogue-summary.ts";
import { calculateDrinkStatus } from "../shared/drink-status.ts";
import { inventoryPageSchema } from "../shared/inventory-queries.ts";
import { wineDetailResponseSchema, wineOptionsPageSchema } from "../shared/wine-resources.ts";
import { problemResponseForError } from "./api/http.ts";
import { userIdForClerkUser } from "./api/ids.ts";
import { drinkStatusExpression, getBottle, queryInventory } from "./api/inventory.ts";
import { inventoryQuerySchema } from "./api/read-query-inputs.ts";
import { asD1, migratedDatabase } from "./d1-support.ts";
import { bottleRoutes } from "./routes/bottles.ts";
import { wineRoutes } from "./routes/wines.ts";

const app = new Hono()
  .route("/", bottleRoutes)
  .route("/", wineRoutes)
  .onError(problemResponseForError);

function tracingD1(d1: D1Database) {
  const queries: string[] = [];
  const traced = new Proxy(d1, {
    get(target, property, receiver) {
      if (property === "prepare")
        return (query: string) => {
          queries.push(query);
          return target.prepare(query);
        };
      const value: unknown = Reflect.get(target, property, receiver);
      return value;
    },
  });
  return { queries, d1: traced };
}

function setup() {
  const sqlite = migratedDatabase();
  const userId = userIdForClerkUser("dev:reader");
  sqlite.prepare("INSERT INTO users(id,clerk_user_id) VALUES (?, 'dev:reader')").run(userId);
  sqlite.exec(`
    INSERT INTO sites(id,name) VALUES ('site','Home'),('shared','Shared'),('private','Private');
    INSERT INTO wineries(id,site_id,name) VALUES ('winery','site','Étage 蓮🍷');
    INSERT INTO wine_vintages(id,site_id,winery_id,base_name,display_name,vintage_label,drink_from_year,drink_to_year) VALUES
      ('wine','site','winery','Reserve','Same name','Unknown',2000,2100),
      ('other-wine','site',null,'Reserve','Same name','Unknown',2000,2100),
      ('empty','shared',null,'Empty','Zero stock 蓮🍷','Unknown',null,null),
      ('private-wine','private',null,'Private','Private','Unknown',null,null);
    INSERT INTO storage_locations(id,site_id,parent_id,name) VALUES ('root','site',null,'Rack, A'),('leaf','site','root','Shelf 蓮🍷');
    INSERT INTO grape_varieties(id,name) VALUES ('grape','Grenache (Garnacha, Alicante)'),('other-grape','Shiraz');
    INSERT INTO wine_constituents(site_id,wine_vintage_id,grape_variety_id) VALUES ('site','wine','grape'),('site','other-wine','other-grape');
  `);
  sqlite
    .prepare(
      "INSERT INTO site_memberships(site_id,user_id,role) VALUES ('site',?,'owner'),('shared',?,'viewer')",
    )
    .run(userId, userId);
  const insert = sqlite.prepare(
    "INSERT INTO bottles(id,site_id,wine_vintage_id,status,created_at) VALUES (?,?,?,?,?)",
  );
  const add = (
    id: string,
    wineId = "wine",
    status = "in_stock",
    createdAt = "2026-01-01 00:00:00",
  ) => {
    insert.run(id, wineId === "private-wine" ? "private" : "site", wineId, status, createdAt);
  };
  const d1 = asD1(sqlite);
  const get = async (path: string, user = "reader") =>
    app.request(`http://localhost${path}`, { headers: { "x-dev-user": user } }, { DB: d1 });
  return { sqlite, userId, add, d1, database: createD1Client(d1), get };
}

await describe("bounded authorized catalogue reads", async () => {
  await it("filters same-name sites and locations by stored IDs through renames", async (context) => {
    const fixture = setup();
    context.after(() => {
      fixture.sqlite.close();
    });
    fixture.add("first");
    fixture.add("sibling");
    fixture.sqlite.exec(`
      UPDATE sites SET name = 'Cellar' WHERE id IN ('site','shared');
      UPDATE storage_locations SET name = 'Rack', parent_id = NULL WHERE id = 'leaf';
      INSERT INTO storage_locations(id,site_id,parent_id,name) VALUES
        ('sibling-location','site',NULL,'Rack'),('shared-location','shared',NULL,'Rack');
      INSERT INTO bottles(id,site_id,wine_vintage_id) VALUES ('other-site-bottle','shared','empty');
      INSERT INTO bottle_locations(bottle_id,site_id,storage_location_id) VALUES
        ('first','site','leaf'),('sibling','site','sibling-location'),('other-site-bottle','shared','shared-location');
    `);
    const selectIds = async (siteId: string, storageLocationId?: string) => {
      const query = new URLSearchParams({
        siteId,
        ...(storageLocationId === undefined ? {} : { storageLocationId }),
      });
      const response = await fixture.get(`/bottles?${query}`);
      assert.equal(response.status, 200);
      const page = inventoryPageSchema.parse(await response.json());
      assert.equal(page.totalCount, 1);
      return page.data.map((bottle) => bottle.id);
    };
    assert.deepEqual(await selectIds("site", "leaf"), ["first"]);
    assert.deepEqual(await selectIds("shared"), ["other-site-bottle"]);
    fixture.sqlite.exec(
      "UPDATE sites SET name='Renamed cellar' WHERE id='site'; UPDATE storage_locations SET name='Renamed rack' WHERE id='leaf'",
    );
    assert.deepEqual(await selectIds("site", "leaf"), ["first"]);
    assert.deepEqual(await selectIds("shared"), ["other-site-bottle"]);
  });

  await it("looks up one consumed bottle and only its wine evidence, with identical absent/private denial", async (context) => {
    const fixture = setup();
    context.after(() => {
      fixture.sqlite.close();
    });
    fixture.add("consumed", "wine", "consumed");
    fixture.add("unrelated", "other-wine");
    fixture.add("hidden", "private-wine");
    fixture.sqlite.exec(`
      INSERT INTO review_sources(id,site_id,name) VALUES ('source','site','Critic');
      INSERT INTO critic_reviews(id,site_id,wine_vintage_id,review_source_id,rating_text) VALUES
        ('wanted-review','site','wine','source','95'),('unrelated-review','site','other-wine','source','80');
      INSERT INTO wine_awards(id,site_id,wine_vintage_id,award_name,award_level) VALUES
        ('wanted-award','site','wine','Show','Gold'),('unrelated-award','site','other-wine','Show','Silver');
    `);
    const { queries, d1: traced } = tracingD1(fixture.d1);
    const bottle = bottleResourceSchema.parse(
      await getBottle({
        database: createD1Client(traced),
        userId: fixture.userId,
        bottleId: "consumed",
      }),
    );
    assert.equal(bottle.status, "consumed");
    assert.deepEqual(
      bottle.criticReviews.map((review) => review.id),
      ["wanted-review"],
    );
    assert.deepEqual(
      bottle.awards.map((award) => award.id),
      ["wanted-award"],
    );
    assert.equal(queries.length, 3);
    assert.match(queries[0] ?? "", /"bottles"\."id" = \?/u);
    assert.match(queries[0] ?? "", /limit \?/u);
    assert.match(queries[1] ?? "", /"critic_reviews"\."wine_vintage_id" = \?/u);
    assert.match(queries[2] ?? "", /"wine_awards"\."wine_vintage_id" = \?/u);
    const missing = await fixture.get("/bottles/missing");
    const hidden = await fixture.get("/bottles/hidden");
    assert.equal(missing.status, 404);
    assert.equal(hidden.status, 404);
    assert.deepEqual(await hidden.json(), await missing.json());
    assert.equal((await fixture.get("/bottles/consumed")).status, 200);
  });

  await it("pages every row once despite duplicate names, Unicode IDs and name changes", async (context) => {
    const fixture = setup();
    context.after(() => {
      fixture.sqlite.close();
    });
    const expected: string[] = [];
    for (let index = 0; index < 207; index += 1) {
      const id = `${String(index).padStart(3, "0")} Étage 蓮🍷`;
      expected.push(id);
      fixture.add(id, index % 2 === 0 ? "wine" : "other-wine");
    }
    fixture.add("older", "wine", "in_stock", "2025-01-01 00:00:00");
    expected.push("older");
    fixture.add("hidden", "private-wine");
    fixture.add("consumed", "wine", "consumed");
    const before = fixture.sqlite.prepare("SELECT * FROM bottles ORDER BY id").all();
    const trace = tracingD1(fixture.d1);
    await queryInventory({
      database: createD1Client(trace.d1),
      userId: fixture.userId,
      input: inventoryQuerySchema.parse({ limit: 100 }),
    });
    assert.equal(
      trace.queries.length,
      4,
      "A page, count and two compact facet queries are independent of page size",
    );
    assert.ok(
      trace.queries.every(
        (query) =>
          !query.includes('"description"') &&
          !query.includes('"critic_reviews"') &&
          !query.includes('"wine_awards"'),
      ),
    );
    const seen: string[] = [];
    let nextPageToken: string | null = null;
    do {
      const query = new URLSearchParams({
        limit: "31",
        ...(nextPageToken === null ? {} : { pageToken: nextPageToken }),
      });
      const response = await fixture.get(`/bottles?${query}`);
      assert.equal(response.status, 200, await response.clone().text());
      const page = inventoryPageSchema.parse(await response.json());
      assert.equal(page.totalCount, 208);
      assert.ok(page.data.length <= 31);
      assert.deepEqual(
        new Set(page.facets.grapeVarieties),
        new Set(["Grenache (Garnacha, Alicante)", "Shiraz"]),
      );
      assert.deepEqual(page.facets.drinkStatuses, ["drink-now"]);
      assert.ok(
        page.data.every(
          (item) => !("description" in item) && !("criticReviews" in item) && !("awards" in item),
        ),
      );
      seen.push(...page.data.map((item) => item.id));
      nextPageToken = page.nextPageToken;
      fixture.sqlite.exec(
        "UPDATE wine_vintages SET display_name='Renamed' WHERE id='wine'; UPDATE wineries SET name='Renamed' WHERE id='winery'",
      );
    } while (nextPageToken !== null);
    assert.deepEqual(seen, expected);
    assert.equal(new Set(seen).size, expected.length);
    assert.deepEqual(fixture.sqlite.prepare("SELECT * FROM bottles ORDER BY id").all(), before);
    const defaultPage = inventoryPageSchema.parse(await (await fixture.get("/bottles")).json());
    assert.equal(defaultPage.data.length, 50);
    assert.equal(
      inventoryPageSchema.parse(await (await fixture.get("/bottles?limit=100")).json()).data.length,
      100,
    );
  });

  await it("applies all filters, queue scope and complete-result counts before limiting", async (context) => {
    const fixture = setup();
    context.after(() => {
      fixture.sqlite.close();
    });
    for (let index = 0; index < 123; index += 1) {
      fixture.add(`match-${index}`);
      fixture.sqlite
        .prepare(
          "INSERT INTO bottle_locations(bottle_id,site_id,storage_location_id,position_hint) VALUES (?,'site','leaf','Top')",
        )
        .run(`match-${index}`);
    }
    fixture.add("other", "other-wine");
    fixture.add("used", "wine", "consumed");
    const filtered = inventoryPageSchema.parse(
      await (
        await fixture.get(
          `/bottles?${new URLSearchParams({ query: "Top", siteId: "site", storageLocationId: "leaf", grapeVariety: "Grenache (Garnacha, Alicante)", drinkStatus: "drink-now", drinkQueue: "true", limit: "7" })}`,
        )
      ).json(),
    );
    assert.equal(filtered.totalCount, 123);
    assert.equal(filtered.data.length, 7);
    assert.deepEqual(filtered.facets.grapeVarieties, ["Grenache (Garnacha, Alicante)"]);
    assert.equal(
      inventoryPageSchema.parse(await (await fixture.get("/bottles?status=any")).json()).totalCount,
      125,
    );
    assert.equal(
      inventoryPageSchema.parse(await (await fixture.get("/bottles?status=consumed")).json())
        .totalCount,
      1,
    );
    assert.equal(
      inventoryPageSchema.parse(await (await fixture.get("/bottles?siteId=private")).json())
        .totalCount,
      0,
    );
    fixture.sqlite.exec(
      "UPDATE wine_vintages SET drink_from_year=2101,drink_to_year=null WHERE id='other-wine'",
    );
    assert.equal(
      inventoryPageSchema.parse(await (await fixture.get("/bottles?drinkQueue=true")).json())
        .totalCount,
      123,
    );
    assert.equal(
      inventoryPageSchema.parse(
        await (await fixture.get("/bottles?drinkQueue=true&drinkStatus=hold")).json(),
      ).totalCount,
      0,
    );
  });

  await it("searches persisted text and ancestor paths without hydrating evidence, with literal SQL metacharacters", async (context) => {
    const fixture = setup();
    context.after(() => {
      fixture.sqlite.close();
    });
    fixture.add("match");
    fixture.add("other", "other-wine");
    fixture.sqlite
      .exec(`INSERT INTO bottle_locations(bottle_id,site_id,storage_location_id,position_hint) VALUES ('match','site','leaf','Position token');
      UPDATE bottles SET notes='Bottle-note-token',lot_code='Lot-token',barcode='100%_"quote' WHERE id='match';
      UPDATE wine_vintages SET description='Description-token',drinking_advice='Advice-token',label_text='Label-token',notes='Wine-note-token',source_url='https://example.com/source-token',address_qualification='Address-token' WHERE id='wine';
      INSERT INTO review_sources(id,site_id,name) VALUES ('source','site','Critic-token');
      INSERT INTO critic_reviews(id,site_id,wine_vintage_id,review_source_id,rating_text,provenance,notes) VALUES ('review','site','wine','source','95 points','Review-provenance-token','Review-note-token');
      INSERT INTO wine_awards(id,site_id,wine_vintage_id,award_name,award_level,award_body,category,provenance,notes) VALUES ('award','site','wine','Show-token','Gold','Award-body-token','Category-token','Award-provenance-token','Award-note-token');`);
    for (const query of [
      "Position token",
      "Bottle-note-token",
      "Lot-token",
      '100%_"quote',
      "Description-token",
      "Advice-token",
      "Label-token",
      "Wine-note-token",
      "source-token",
      "Address-token",
      "Critic-token: 95 points",
      "Review-provenance-token",
      "Review-note-token",
      "Show-token",
      "Award-body-token",
      "Category-token",
      "Award-provenance-token",
      "Award-note-token",
      "Rack, A / Shelf 蓮🍷",
      "Grenache (Garnacha, Alicante)",
      "Étage",
    ]) {
      const response = await fixture.get(`/bottles?${new URLSearchParams({ query })}`);
      assert.equal(response.status, 200, query);
      const page = inventoryPageSchema.parse(await response.json());
      assert.deepEqual(
        page.data.map((item) => item.id),
        ["match"],
        query,
      );
    }
    assert.equal(
      inventoryPageSchema.parse(await (await fixture.get("/bottles?query=%25")).json()).totalCount,
      1,
    );
    assert.equal(
      inventoryPageSchema.parse(await (await fixture.get("/bottles?query=%C3%A9tage")).json())
        .totalCount,
      0,
      "D1 Unicode casing is deliberately exact; ASCII remains case-insensitive",
    );
    assert.equal(
      inventoryPageSchema.parse(
        await (await fixture.get("/bottles?query=description-TOKEN")).json(),
      ).totalCount,
      1,
    );
  });

  await it("rejects invalid bounds and cursor contexts before any partial page is served", async (context) => {
    const fixture = setup();
    context.after(() => {
      fixture.sqlite.close();
    });
    fixture.add("one");
    fixture.add("two");
    const page = inventoryPageSchema.parse(await (await fixture.get("/bottles?limit=1")).json());
    assert.ok(page.nextPageToken !== null);
    for (const query of [
      "limit=0",
      "limit=101",
      "limit=1.5",
      "pageToken=invalid",
      `siteId=shared&pageToken=${encodeURIComponent(page.nextPageToken)}`,
      "drinkQueue=maybe",
    ]) {
      assert.equal((await fixture.get(`/bottles?${query}`)).status, 400, query.slice(0, 100));
    }
    assert.equal(
      (
        await fixture.get(
          `/bottles?${new URLSearchParams({ pageToken: page.nextPageToken })}`,
          "stranger",
        )
      ).status,
      400,
    );
    assert.equal(
      (await fixture.get(`/wines?${new URLSearchParams({ pageToken: page.nextPageToken })}`))
        .status,
      400,
    );
  });

  await it("accepts its own long cursor for an opaque stored Unicode ID", async (context) => {
    const fixture = setup();
    context.after(() => {
      fixture.sqlite.close();
    });
    fixture.add(`a${"蓮🍷".repeat(2000)}`);
    fixture.add("z");
    const first = inventoryPageSchema.parse(await (await fixture.get("/bottles?limit=1")).json());
    assert.ok(first.nextPageToken !== null);
    assert.ok(first.nextPageToken.length > 16_384);
    const response = await fixture.get(
      `/bottles?${new URLSearchParams({ limit: "1", pageToken: first.nextPageToken })}`,
    );
    assert.equal(response.status, 200);
    const second = inventoryPageSchema.parse(await response.json());
    assert.deepEqual(
      second.data.map((item) => item.id),
      ["z"],
    );
    assert.equal(second.nextPageToken, null);
  });

  await it("provides bounded site-scoped wine choices including zero stock and a direct read-only wine detail", async (context) => {
    const fixture = setup();
    context.after(() => {
      fixture.sqlite.close();
    });
    const first = wineOptionsPageSchema.parse(await (await fixture.get("/wines?limit=1")).json());
    assert.equal(first.totalCount, 3);
    assert.equal(first.data.length, 1);
    const seen = [first.data[0]?.wineVintageId];
    let token = first.nextPageToken;
    fixture.sqlite.exec("UPDATE wine_vintages SET display_name='Renamed' WHERE id='empty'");
    while (token !== null) {
      const page = wineOptionsPageSchema.parse(
        await (
          await fixture.get(`/wines?${new URLSearchParams({ limit: "1", pageToken: token })}`)
        ).json(),
      );
      seen.push(...page.data.map((wine) => wine.wineVintageId));
      token = page.nextPageToken;
    }
    assert.deepEqual(new Set(seen), new Set(["wine", "other-wine", "empty"]));
    const empty = wineOptionsPageSchema.parse(
      await (await fixture.get("/wines?siteId=shared&query=Renamed")).json(),
    );
    assert.deepEqual(
      empty.data.map((wine) => wine.wineVintageId),
      ["empty"],
    );
    assert.equal(
      wineOptionsPageSchema.parse(await (await fixture.get("/wines?siteId=private")).json())
        .totalCount,
      0,
    );
    assert.equal(
      wineOptionsPageSchema.parse(
        await (
          await fixture.get(
            `/wines?${new URLSearchParams({ query: "Grenache (Garnacha, Alicante)" })}`,
          )
        ).json(),
      ).totalCount,
      1,
    );
    const detail = wineDetailResponseSchema.parse(
      await (await fixture.get("/wines/empty")).json(),
    ).data;
    assert.equal(detail.bottleCount, 0);
    assert.equal(detail.inStockBottleCount, 0);
    const missing = await fixture.get("/wines/missing");
    const hidden = await fixture.get("/wines/private-wine");
    assert.equal(hidden.status, 404);
    assert.deepEqual(await hidden.json(), await missing.json());
  });

  await it("counts actual whole-catalogue stock and capture work independently of loaded pages", async (context) => {
    const fixture = setup();
    context.after(() => {
      fixture.sqlite.close();
    });
    for (let index = 0; index < 121; index += 1) fixture.add(`stock-${index}`);
    fixture.add("hold", "other-wine");
    fixture.add("used", "wine", "consumed");
    fixture.add("hidden", "private-wine");
    fixture.sqlite.exec(
      "UPDATE wine_vintages SET drink_from_year=2101,drink_to_year=null WHERE id='other-wine'",
    );
    for (const [id, status] of [
      ["review", "needs_review"],
      ["active", "queued"],
      ["done", "imported"],
      ["unknown", "legacy-status"],
    ]) {
      fixture.sqlite
        .prepare("INSERT INTO bottle_captures(id,site_id,user_id,status) VALUES (?,'site',?,?)")
        .run(id ?? "", fixture.userId, status ?? "");
    }
    const result = catalogueSummarySchema.parse(
      await (await fixture.get("/catalogue-summary")).json(),
    ).data;
    assert.deepEqual(result, {
      inStockBottleCount: 122,
      drinkQueueBottleCount: 121,
      captures: { actionable: 2, processing: 1, imported: 1 },
    });
    const outsider = catalogueSummarySchema.parse(
      await (await fixture.get("/catalogue-summary", "stranger")).json(),
    ).data;
    assert.deepEqual(outsider, {
      inStockBottleCount: 0,
      drinkQueueBottleCount: 0,
      captures: { actionable: 0, processing: 0, imported: 0 },
    });
  });

  await it("agrees with explicit drink-window boundary examples in SQL and shared calculation", async (context) => {
    const fixture = setup();
    context.after(() => {
      fixture.sqlite.close();
    });
    fixture.add("bottle");
    const now = new Date("2026-01-01T00:00:00Z");
    const cases: readonly [number | null, number | null, string][] = [
      [null, null, "unknown"],
      [2027, 2030, "hold"],
      [2026, 2030, "drink-now"],
      [null, 2029, "drink-now"],
      [2020, 2028, "drink-soon"],
      [null, 2026, "drink-soon"],
      [2020, 2025, "past-window"],
      [2026, null, "drink-now"],
    ];
    for (const [drinkFromYear, drinkToYear, expected] of cases) {
      fixture.sqlite
        .prepare("UPDATE wine_vintages SET drink_from_year=?,drink_to_year=? WHERE id='wine'")
        .run(drinkFromYear, drinkToYear);
      assert.equal(calculateDrinkStatus({ drinkFromYear, drinkToYear, now }), expected);
      const rows = await fixture.database
        .select({ status: drinkStatusExpression(now) })
        .from(wineVintages);
      assert.equal(rows[0]?.status, expected);
      const page = await queryInventory({
        database: fixture.database,
        userId: fixture.userId,
        input: inventoryQuerySchema.parse({ drinkStatus: expected }),
        now,
      });
      assert.equal(page.totalCount, 1, expected);
    }
  });
});
