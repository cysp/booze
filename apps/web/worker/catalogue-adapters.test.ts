// oxlint-disable import/max-dependencies -- Exercise the HTTP and MCP adapters against the same stored catalogue.
import assert from "node:assert/strict";
import { it } from "node:test";
import { createD1Client } from "@chikachow/booze-db";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Hono } from "hono";
import { z } from "zod";
import { userIdForClerkUser } from "./api/ids.ts";
import { problemResponseForError } from "./api/http.ts";
import type { Bindings } from "./api/types.ts";
import { asD1, migratedDatabase } from "./d1-support.ts";
import { mcpEntityId } from "./mcp/ids.ts";
import { createBoozeMcpServer } from "./mcp/server.ts";
import { bottleRoutes } from "./routes/bottles.ts";
import { storageLocationRoutes } from "./routes/storage-locations.ts";

const resultFlags = z.object({ changed: z.boolean(), affectedRecordCount: z.number() });

async function setup() {
  const sqlite = migratedDatabase();
  const userId = userIdForClerkUser("dev:tester");
  sqlite.prepare("INSERT INTO users (id,clerk_user_id) VALUES (?, 'dev:tester')").run(userId);
  sqlite.exec(`
    INSERT INTO sites(id,name) VALUES ('site','Cellar');
    INSERT INTO wine_vintages(id,site_id,base_name,display_name,vintage_label)
      VALUES ('wine','site','Wine','Wine','Unknown');
    INSERT INTO bottles(id,site_id,wine_vintage_id) VALUES ('bottle','site','wine');
    INSERT INTO storage_locations(id,site_id,name) VALUES ('left','site','Left'),('right','site','Right');
  `);
  sqlite
    .prepare("INSERT INTO site_memberships(site_id,user_id,role) VALUES ('site',?,'owner')")
    .run(userId);
  const d1 = asD1(sqlite);
  const server = createBoozeMcpServer({ database: createD1Client(d1), userId });
  const client = new Client({ name: "catalogue-adapter-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  await client.listTools();
  const app = new Hono<{ Bindings: Bindings }>()
    .route("/", bottleRoutes)
    .route("/", storageLocationRoutes)
    .onError(problemResponseForError);
  return {
    client,
    sqlite,
    async request(path: string, method: string, body: unknown) {
      return app.request(
        `http://localhost${path}`,
        {
          method,
          headers: { "x-dev-user": "tester", "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        { DB: d1 },
      );
    },
    close: async () => {
      await client.close();
      await server.close();
      sqlite.close();
    },
  };
}

await it("HTTP and MCP preserve consumed location history and reject subsequent moves", async (context) => {
  const fixture = await setup();
  context.after(fixture.close);
  assert.equal(
    (
      await fixture.request("/bottles/bottle", "PATCH", {
        storageLocationId: "left",
        positionHint: "A2",
      })
    ).status,
    200,
  );
  const consumed = await fixture.client.callTool({
    name: "cellar.mark_bottle_consumed",
    arguments: { bottleId: "bottle" },
  });
  assert.notEqual(consumed.isError, true, JSON.stringify(consumed));
  assert.deepEqual(consumed.structuredContent, {
    changed: true,
    affectedRecordCount: 1,
    before: {
      bottleId: "bottle",
      siteId: "site",
      wineVintageId: "wine",
      status: "in_stock",
      storageLocationId: "left",
      positionHint: "A2",
    },
    after: {
      bottleId: "bottle",
      siteId: "site",
      wineVintageId: "wine",
      status: "consumed",
      storageLocationId: "left",
      positionHint: "A2",
    },
  });
  assert.equal(
    (await fixture.request("/bottles/bottle", "PATCH", { storageLocationId: "right" })).status,
    400,
  );
  const move = await fixture.client.callTool({
    name: "cellar.set_bottle_location",
    arguments: { bottleId: "bottle", storageLocationId: mcpEntityId("location", "right") },
  });
  assert.equal(move.isError, true);
  assert.equal(
    fixture.sqlite.prepare("SELECT storage_location_id FROM bottle_locations").get()?.[
      "storage_location_id"
    ],
    "left",
  );
  assert.equal(
    fixture.sqlite.prepare("SELECT count(*) AS n FROM mcp_tool_audit_events").get()?.["n"],
    2,
  );
});

await it("HTTP and MCP reuse the same exact location and both reject a type-changing create", async (context) => {
  const fixture = await setup();
  context.after(fixture.close);
  const input = { siteId: "site", name: "Rack", locationType: "rack" };
  const http = await fixture.request("/storage-locations", "POST", input);
  assert.equal(http.status, 201);
  const repeat = await fixture.client.callTool({
    name: "cellar.create_storage_location",
    arguments: input,
  });
  assert.notEqual(repeat.isError, true, JSON.stringify(repeat));
  assert.deepEqual(resultFlags.parse(repeat.structuredContent), {
    changed: false,
    affectedRecordCount: 0,
  });
  assert.equal(
    fixture.sqlite.prepare("SELECT count(*) AS n FROM storage_locations WHERE name='Rack'").get()?.[
      "n"
    ],
    1,
  );
  assert.equal(
    (await fixture.request("/storage-locations", "POST", { ...input, locationType: "shelf" }))
      .status,
    409,
  );
  const conflict = await fixture.client.callTool({
    name: "cellar.create_storage_location",
    arguments: { ...input, locationType: "shelf" },
  });
  assert.equal(conflict.isError, true);
  assert.equal(
    fixture.sqlite.prepare("SELECT location_type FROM storage_locations WHERE name='Rack'").get()?.[
      "location_type"
    ],
    "rack",
  );
  assert.equal(
    fixture.sqlite.prepare("SELECT count(*) AS n FROM mcp_tool_audit_events").get()?.["n"],
    2,
  );
});

await it("MCP drinking-window writes return compact committed facts and audit no-ops", async (context) => {
  const fixture = await setup();
  context.after(fixture.close);
  const args = { wineId: mcpEntityId("wine", "wine"), drinkFromYear: 2025, drinkToYear: 2030 };
  const first = await fixture.client.callTool({
    name: "cellar.set_drinking_window",
    arguments: args,
  });
  assert.notEqual(first.isError, true, JSON.stringify(first));
  assert.deepEqual(first.structuredContent, {
    changed: true,
    affectedRecordCount: 1,
    affectedBottleCount: 1,
    before: { id: "wine", siteId: "site", drinkFromYear: null, drinkToYear: null, bottleCount: 1 },
    after: { id: "wine", siteId: "site", drinkFromYear: 2025, drinkToYear: 2030, bottleCount: 1 },
  });
  const repeat = await fixture.client.callTool({
    name: "cellar.set_drinking_window",
    arguments: args,
  });
  assert.notEqual(repeat.isError, true, JSON.stringify(repeat));
  assert.equal(resultFlags.parse(repeat.structuredContent).changed, false);
  assert.deepEqual(
    fixture.sqlite
      .prepare("SELECT affected_record_count FROM mcp_tool_audit_events ORDER BY rowid")
      .all()
      .map((row) => row["affected_record_count"]),
    [1, 0],
  );
});
