import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import { createD1Client } from "@chikachow/booze-db";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import { asD1, migratedDatabase } from "./d1-support.ts";
import { createBoozeMcpServer } from "./mcp/server.ts";

const ids = {
  site: ` site/旧い地下室/${"legacy-".repeat(20)} `,
  winery: ` winery/🍇/${"legacy-".repeat(20)} `,
  wine: ` wine/🍷/${"legacy-".repeat(20)} `,
  location: ` location/棚/${"legacy-".repeat(20)} `,
  source: ` source/批評家/${"legacy-".repeat(20)} `,
  review: ` review/評価/${"legacy-".repeat(20)} `,
  bottle: ` bottle/瓶/${"legacy-".repeat(20)} `,
  otherWine: "c71840ed-405d-44cb-bdc1-9421a9d58324",
};

const entity = z.object({
  wineId: z.string().optional(),
  wineryId: z.string().nullable().optional(),
  storageLocationId: z.string().nullable().optional(),
  reviewSourceId: z.string().optional(),
  criticReviewId: z.string().optional(),
});

async function setup(context: TestContext) {
  const sqlite = migratedDatabase();
  sqlite.exec(`
    INSERT INTO users (id, clerk_user_id) VALUES ('owner', 'owner');
    INSERT INTO sites (id, name) VALUES ('other', 'Cellar'), ('hidden', 'Private');
    INSERT INTO site_memberships (site_id, user_id, role) VALUES ('other', 'owner', 'owner');
    INSERT INTO wineries (id, site_id, name) VALUES ('other-winery', 'other', 'Estate');
    INSERT INTO wine_vintages (id, site_id, base_name, display_name, vintage_label)
      VALUES ('hidden-wine', 'hidden', 'Reserve', 'Reserve', 'Unknown');
    INSERT INTO storage_locations (id, site_id, name)
      VALUES ('other-location', 'other', 'Rack'), ('hidden-location', 'hidden', 'Rack');
    INSERT INTO review_sources (id, site_id, name)
      VALUES ('other-source', 'other', 'Critic'), ('hidden-source', 'hidden', 'Critic');
    INSERT INTO review_sources (id, name) VALUES ('global-source', 'Global critic');
    INSERT INTO critic_reviews (id, site_id, wine_vintage_id, review_source_id, rating_text)
      VALUES ('hidden-review', 'hidden', 'hidden-wine', 'hidden-source', '90 points');
  `);
  sqlite.prepare("INSERT INTO sites (id, name) VALUES (?, 'Cellar')").run(ids.site);
  sqlite
    .prepare("INSERT INTO site_memberships (site_id, user_id, role) VALUES (?, 'owner', 'owner')")
    .run(ids.site);
  sqlite
    .prepare("INSERT INTO wineries (id, site_id, name) VALUES (?, ?, 'Estate')")
    .run(ids.winery, ids.site);
  sqlite
    .prepare(
      "INSERT INTO wine_vintages (id, site_id, winery_id, base_name, display_name, vintage_label) VALUES (?, ?, ?, 'Reserve', 'Reserve', 'Unknown')",
    )
    .run(ids.wine, ids.site, ids.winery);
  sqlite
    .prepare(
      "INSERT INTO wine_vintages (id, site_id, winery_id, base_name, display_name, vintage_label) VALUES (?, 'other', 'other-winery', 'Reserve', 'Reserve', 'Unknown')",
    )
    .run(ids.otherWine);
  sqlite
    .prepare("INSERT INTO bottles (id, site_id, wine_vintage_id) VALUES (?, ?, ?)")
    .run(ids.bottle, ids.site, ids.wine);
  sqlite
    .prepare("INSERT INTO storage_locations (id, site_id, name) VALUES (?, ?, 'Rack')")
    .run(ids.location, ids.site);
  sqlite
    .prepare(
      "INSERT INTO bottle_locations (bottle_id, site_id, storage_location_id) VALUES (?, ?, ?)",
    )
    .run(ids.bottle, ids.site, ids.location);
  sqlite
    .prepare("INSERT INTO review_sources (id, site_id, name) VALUES (?, ?, 'Critic')")
    .run(ids.source, ids.site);
  sqlite
    .prepare(
      "INSERT INTO critic_reviews (id, site_id, wine_vintage_id, review_source_id, rating_text) VALUES (?, ?, ?, ?, '95 points')",
    )
    .run(ids.review, ids.site, ids.wine, ids.source);
  const server = createBoozeMcpServer({ database: createD1Client(asD1(sqlite)), userId: "owner" });
  const client = new Client({ name: "canonical-identity-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  await client.listTools();
  context.after(async () => {
    await client.close();
    await server.close();
    sqlite.close();
  });
  return {
    sqlite,
    client,
    call: async (name: string, args: Record<string, unknown> = {}): Promise<unknown> => {
      const result = await client.callTool({ name, arguments: args });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      return result.structuredContent;
    },
  };
}

await it("returns exact stored legacy and generated IDs across every MCP entity and preserves them after renaming", async (context) => {
  const { call, sqlite } = await setup(context);
  const wines = z.object({ wines: z.array(entity) }).parse(await call("cellar.list_wines"));
  assert.deepEqual(
    new Set(wines.wines.map((wine) => wine.wineId)),
    new Set([ids.wine, ids.otherWine]),
  );
  assert.equal(wines.wines.find((wine) => wine.wineId === ids.wine)?.wineryId, ids.winery);
  const wineries = z
    .object({ wineries: z.array(entity) })
    .parse(await call("cellar.list_wineries"));
  assert.deepEqual(
    new Set(wineries.wineries.map((winery) => winery.wineryId)),
    new Set([ids.winery, "other-winery"]),
  );
  const locations = z
    .object({ locations: z.array(entity) })
    .parse(await call("cellar.list_storage_locations"));
  assert.deepEqual(
    new Set(locations.locations.map((location) => location.storageLocationId)),
    new Set([ids.location, "other-location"]),
  );
  const sources = z
    .object({ reviewSources: z.array(entity) })
    .parse(await call("cellar.list_review_sources"));
  assert.deepEqual(
    new Set(sources.reviewSources.map((source) => source.reviewSourceId)),
    new Set([ids.source, "other-source", "global-source"]),
  );
  const reviews = z
    .object({ criticReviews: z.array(entity) })
    .parse(await call("cellar.list_critic_reviews"));
  assert.deepEqual(reviews.criticReviews, [
    { criticReviewId: ids.review, reviewSourceId: ids.source, wineId: ids.wine },
  ]);
  for (const name of [
    "cellar.search_bottles",
    "cellar.list_drink_queue",
    "cellar.list_location_bottles",
  ]) {
    const result = z
      .object({ bottles: z.array(entity) })
      .parse(
        await call(
          name,
          name === "cellar.list_location_bottles"
            ? { locationId: ids.location }
            : name === "cellar.list_drink_queue"
              ? { drinkStatuses: ["unknown"] }
              : {},
        ),
      );
    assert.deepEqual(result.bottles, [
      { wineId: ids.wine, wineryId: ids.winery, storageLocationId: ids.location },
    ]);
  }
  sqlite
    .prepare("UPDATE wine_vintages SET display_name = 'Renamed wine' WHERE id = ?")
    .run(ids.wine);
  sqlite.prepare("UPDATE wineries SET name = 'Renamed estate' WHERE id = ?").run(ids.winery);
  sqlite
    .prepare("UPDATE storage_locations SET name = 'Renamed rack' WHERE id = ?")
    .run(ids.location);
  sqlite.prepare("UPDATE review_sources SET name = 'Renamed critic' WHERE id = ?").run(ids.source);
  const wine = z
    .object({ wine: entity.extend({ wine: z.string(), winery: z.string() }) })
    .parse(await call("cellar.get_wine", { wineId: ids.wine }));
  assert.deepEqual(wine.wine, {
    wineId: ids.wine,
    wineryId: ids.winery,
    wine: "Renamed wine",
    winery: "Renamed estate",
  });
  const bottle = z
    .object({ bottle: entity })
    .parse(await call("cellar.get_bottle", { bottleId: ids.bottle }));
  assert.deepEqual(bottle.bottle, {
    wineId: ids.wine,
    wineryId: ids.winery,
    storageLocationId: ids.location,
  });
});

await it("accepts canonical IDs in complete MCP writes and returns persisted generated IDs", async (context) => {
  const { call, sqlite } = await setup(context);
  await call("cellar.set_drinking_window", {
    wineId: ids.wine,
    drinkFromYear: 2025,
    drinkToYear: 2030,
  });
  const created = z
    .object({ after: z.object({ id: z.string(), parentId: z.string().nullable() }) })
    .parse(
      await call("cellar.create_storage_location", {
        siteId: ids.site,
        parentStorageLocationId: ids.location,
        name: "New shelf",
      }),
    );
  assert.equal(created.after.parentId, ids.location);
  assert.equal(
    sqlite.prepare("SELECT id FROM storage_locations WHERE name = 'New shelf'").get()?.["id"],
    created.after.id,
  );
  await call("cellar.set_bottle_location", {
    bottleId: ids.bottle,
    storageLocationId: created.after.id,
  });
  assert.equal(
    sqlite
      .prepare("SELECT storage_location_id FROM bottle_locations WHERE bottle_id = ?")
      .get(ids.bottle)?.["storage_location_id"],
    created.after.id,
  );
  const updated = z.object({ criticReview: entity }).parse(
    await call("cellar.upsert_critic_review", {
      wineId: ids.wine,
      reviewSourceId: ids.source,
      ratingText: "96 points",
    }),
  );
  assert.deepEqual(updated.criticReview, {
    criticReviewId: ids.review,
    reviewSourceId: ids.source,
    wineId: ids.wine,
  });
  const globalReview = z.object({ criticReview: entity }).parse(
    await call("cellar.upsert_critic_review", {
      wineId: ids.wine,
      reviewSourceId: "global-source",
      ratingText: "Recommended",
    }),
  );
  assert.equal(globalReview.criticReview.reviewSourceId, "global-source");
  assert.equal(
    sqlite
      .prepare("SELECT id FROM critic_reviews WHERE review_source_id = 'global-source'")
      .get()?.["id"],
    globalReview.criticReview.criticReviewId,
  );
  await call("cellar.delete_critic_review", { criticReviewId: ids.review });
  assert.equal(
    sqlite.prepare("SELECT count(*) AS n FROM critic_reviews WHERE id = ?").get(ids.review)?.["n"],
    0,
  );
  assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
});

await it("conceals inaccessible canonical IDs exactly like missing IDs", async (context) => {
  const { client } = await setup(context);
  for (const [name, field, hidden, rest] of [
    ["cellar.get_wine", "wineId", "hidden-wine", {}],
    [
      "cellar.set_drinking_window",
      "wineId",
      "hidden-wine",
      { drinkFromYear: 2025, drinkToYear: 2030 },
    ],
    ["cellar.list_location_bottles", "locationId", "hidden-location", {}],
    [
      "cellar.upsert_critic_review",
      "reviewSourceId",
      "hidden-source",
      { wineId: ids.wine, ratingText: "96 points" },
    ],
    ["cellar.delete_critic_review", "criticReviewId", "hidden-review", {}],
  ] as const) {
    const hiddenResult = await client.callTool({ name, arguments: { ...rest, [field]: hidden } });
    const missingResult = await client.callTool({
      name,
      arguments: { ...rest, [field]: "missing" },
    });
    assert.equal(hiddenResult.isError, true, name);
    assert.equal(missingResult.isError, true, name);
    assert.doesNotMatch(JSON.stringify(hiddenResult.content), /Input validation error/u);
    assert.deepEqual(hiddenResult.content, missingResult.content, name);
  }
});

await it("rejects cross-site canonical relations even when both sites are accessible", async (context) => {
  const { client, sqlite } = await setup(context);
  for (const [name, args] of [
    ["cellar.set_bottle_location", { bottleId: ids.bottle, storageLocationId: "other-location" }],
    [
      "cellar.create_storage_location",
      { siteId: ids.site, parentStorageLocationId: "other-location", name: "Wrong parent" },
    ],
    [
      "cellar.upsert_critic_review",
      { wineId: ids.wine, reviewSourceId: "other-source", ratingText: "96 points" },
    ],
  ] as const) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true, JSON.stringify(result));
    assert.doesNotMatch(JSON.stringify(result.content), /Input validation error/u);
  }
  assert.equal(
    sqlite.prepare("SELECT storage_location_id FROM bottle_locations").get()?.[
      "storage_location_id"
    ],
    ids.location,
  );
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM mcp_tool_audit_events").get()?.["n"], 0);
});

await it("preserves exact structured grape varieties and brands containing commas, quotes and Unicode", async (context) => {
  const { call, sqlite } = await setup(context);
  const name = '葡萄, "Rare"';
  sqlite.prepare("INSERT INTO grape_varieties (id, name) VALUES ('grape', ?)").run(name);
  sqlite
    .prepare(
      "INSERT INTO wine_constituents (site_id, wine_vintage_id, grape_variety_id) VALUES (?, ?, 'grape')",
    )
    .run(ids.site, ids.wine);
  sqlite.prepare("UPDATE wine_vintages SET brand_name = ? WHERE id = ?").run(name, ids.wine);
  const grapeEntity = z.object({ grapeVarieties: z.array(z.string()) });
  const wines = z
    .object({ wines: z.array(grapeEntity) })
    .parse(await call("cellar.list_wines", { siteId: ids.site }));
  assert.deepEqual(wines.wines, [{ grapeVarieties: [name] }]);
  const wine = z
    .object({ wine: grapeEntity })
    .parse(await call("cellar.get_wine", { wineId: ids.wine }));
  assert.deepEqual(wine.wine.grapeVarieties, [name]);
  const bottles = z
    .object({ bottles: z.array(grapeEntity) })
    .parse(await call("cellar.search_bottles"));
  assert.deepEqual(bottles.bottles, [{ grapeVarieties: [name] }]);
  const wineries = z
    .object({ wineries: z.array(z.object({ brands: z.array(z.string()) })) })
    .parse(await call("cellar.list_wineries", { siteId: ids.site }));
  assert.deepEqual(wineries.wineries, [{ brands: [name] }]);
});
