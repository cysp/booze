import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Hono } from "hono";
import { isWineOption } from "../shared/wine-options.ts";
import { problemResponseForError } from "./api/http.ts";
import { userIdForClerkUser } from "./api/ids.ts";
import type { Bindings } from "./api/types.ts";
import { asD1, migratedDatabase } from "./d1-support.ts";
import { bottleRoutes } from "./routes/bottles.ts";
import { wineRoutes } from "./routes/wines.ts";

const app = new Hono<{ Bindings: Bindings }>()
  .route("/", wineRoutes)
  .route("/", bottleRoutes)
  .onError(problemResponseForError);

await describe("wine selection collection", async () => {
  await it("includes consumed-only and zero-bottle wines from every readable site without changing inventory", async () => {
    const sqlite = migratedDatabase();
    const user = userIdForClerkUser("dev:reader");
    sqlite.prepare("INSERT INTO users (id, clerk_user_id) VALUES (?, 'dev:reader')").run(user);
    sqlite.exec(
      `INSERT INTO sites (id, name) VALUES ('home', 'Home'), ('shared', 'Shared'), ('private', 'Private');`,
    );
    sqlite
      .prepare(
        "INSERT INTO site_memberships (site_id, user_id, role) VALUES ('home', ?, 'owner'), ('shared', ?, 'viewer')",
      )
      .run(user, user);
    sqlite.exec(`
      INSERT INTO wine_vintages (id, site_id, base_name, display_name, vintage_label)
        VALUES ('stock', 'home', '', 'Stock wine', 'Unknown'), ('consumed', 'home', '', 'Consumed wine', 'NV'),
               ('empty', 'shared', '', 'Zero bottle wine', 'Unknown'), ('hidden', 'private', '', 'Private wine', 'Unknown');
      INSERT INTO bottles (id, site_id, wine_vintage_id, status)
        VALUES ('stock-bottle', 'home', 'stock', 'in_stock'), ('consumed-bottle', 'home', 'consumed', 'consumed');
      INSERT INTO grape_varieties (id, name) VALUES ('one', 'Shiraz'), ('two', 'Cabernet Sauvignon');
      INSERT INTO wine_constituents (site_id, wine_vintage_id, grape_variety_id)
        VALUES ('home', 'consumed', 'one'), ('home', 'consumed', 'two');
    `);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Routes require only local development authentication and the migrated D1 fixture.
    const env = { DB: asD1(sqlite) } as Bindings;
    try {
      const response = await app.request(
        "http://localhost/wines",
        { headers: { "x-dev-user": "reader" } },
        env,
      );
      assert.equal(response.status, 200);
      const payload: unknown = await response.json();
      assert.ok(
        typeof payload === "object" &&
          payload !== null &&
          "data" in payload &&
          Array.isArray(payload.data),
      );
      assert.ok(payload.data.every(isWineOption));
      const wines = payload.data.filter(isWineOption);
      assert.deepEqual(
        new Set(wines.map((wine) => wine.wineVintageId)),
        new Set(["stock", "consumed", "empty"]),
      );
      assert.equal(wines.length, 3);
      assert.deepEqual(wines.find((wine) => wine.wineVintageId === "consumed")?.grapeVarieties, [
        "Cabernet Sauvignon",
        "Shiraz",
      ]);
      assert.equal(
        wines.find((wine) => wine.wineVintageId === "consumed")?.vintageStatus,
        "unknown",
      );
      assert.equal(wines.find((wine) => wine.wineVintageId === "empty")?.wineryName, "");
      const inventory = await app.request(
        "http://localhost/bottles",
        { headers: { "x-dev-user": "reader" } },
        env,
      );
      assert.equal(inventory.status, 200);
      const inventoryJson = await inventory.text();
      assert.ok(inventoryJson.includes('"id":"stock-bottle"'));
      assert.ok(!inventoryJson.includes('"id":"consumed-bottle"'));
      const stranger = await app.request(
        "http://localhost/wines",
        { headers: { "x-dev-user": "stranger" } },
        env,
      );
      assert.deepEqual(await stranger.json(), { data: [], totalCount: 0, nextPageToken: null });
      const unauthenticated = await app.request("http://localhost/wines", {}, env);
      assert.notEqual(unauthenticated.status, 200);
    } finally {
      sqlite.close();
    }
  });
});
