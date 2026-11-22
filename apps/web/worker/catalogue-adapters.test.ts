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
import { createBoozeMcpServer } from "./mcp/server.ts";
import { bottleCaptureRoutes } from "./routes/bottle-captures.ts";
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
  const server = createBoozeMcpServer({
    requestUrl: new URL("http://localhost/mcp"),
    database: createD1Client(d1),
    userId,
  });
  const client = new Client({ name: "catalogue-adapter-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  await client.listTools();
  const app = new Hono<{ Bindings: Bindings }>()
    .route("/", bottleRoutes)
    .route("/", bottleCaptureRoutes)
    .route("/", storageLocationRoutes)
    .onError(problemResponseForError);
  return {
    client,
    call: async (name: string, args: Record<string, unknown>) =>
      client.callTool({ name, arguments: args }),
    sqlite,
    userId,
    request: async (path: string, method: string, body: unknown) => {
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
    arguments: { bottleId: "bottle", storageLocationId: "right" },
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
  const { after } = z
    .object({ after: z.object({ id: z.string() }) })
    .parse(repeat.structuredContent);
  const child = await fixture.client.callTool({
    name: "cellar.create_storage_location",
    arguments: { ...input, name: "Shelf", parentStorageLocationId: after.id },
  });
  assert.notEqual(child.isError, true, JSON.stringify(child));
  assert.equal(
    z.object({ after: z.object({ parentId: z.string() }) }).parse(child.structuredContent).after
      .parentId,
    after.id,
  );
});

await it("MCP drinking-window writes return compact committed facts and audit no-ops", async (context) => {
  const fixture = await setup();
  context.after(fixture.close);
  const args = { wineId: "wine", drinkFromYear: 2025, drinkToYear: 2030 };
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

await it("MCP manual entry returns a replayable receipt and restore preserves the consumed bottle's identity", async (context) => {
  const { call, sqlite, close } = await setup();
  context.after(close);
  const input = {
    siteId: "site",
    wineId: "wine",
    quantity: 2,
    storageLocationId: "left",
    operationId: crypto.randomUUID(),
  };
  const add = await call("cellar.add_bottles", input);
  assert.notEqual(add.isError, true, JSON.stringify(add));
  const receipt = z
    .object({
      after: z.object({ bottleIds: z.array(z.string()), wineVintageId: z.string() }),
      affectedRecordCount: z.number(),
    })
    .parse(add.structuredContent);
  assert.equal(receipt.affectedRecordCount, 2);
  assert.equal(receipt.after.wineVintageId, "wine");
  assert.equal(new Set(receipt.after.bottleIds).size, 2);
  assert.deepEqual(
    (await call("cellar.add_bottles", input)).structuredContent,
    add.structuredContent,
  );
  assert.equal((await call("cellar.add_bottles", { ...input, quantity: 3 })).isError, true);
  assert.equal(
    (
      await call("cellar.add_bottles", {
        ...input,
        operationId: crypto.randomUUID(),
        wine: { wineryName: "Ambiguous" },
      })
    ).isError,
    true,
  );
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM bottles").get()?.["n"], 3);
  assert.equal(
    sqlite
      .prepare(
        "SELECT count(*) AS n FROM mcp_tool_audit_events WHERE tool_name='cellar.add_bottles'",
      )
      .get()?.["n"],
    1,
  );

  const [bottleId] = receipt.after.bottleIds;
  assert.ok(bottleId !== undefined);
  assert.notEqual((await call("cellar.mark_bottle_consumed", { bottleId })).isError, true);
  const searchRows = z.object({ bottles: z.array(z.object({ bottleId: z.string() })) });
  const stock = searchRows.parse((await call("cellar.search_bottles", {})).structuredContent);
  assert.equal(
    stock.bottles.some((row) => row.bottleId === bottleId),
    false,
  );
  const consumed = searchRows.parse(
    (await call("cellar.search_bottles", { status: "consumed" })).structuredContent,
  );
  assert.deepEqual(consumed.bottles, [{ bottleId }]);
  const restored = await call("cellar.restore_bottle", { bottleId });
  assert.deepEqual(resultFlags.parse(restored.structuredContent), {
    changed: true,
    affectedRecordCount: 1,
  });
  assert.deepEqual(
    z
      .object({
        after: z.object({
          bottleId: z.string(),
          status: z.string(),
          storageLocationId: z.string(),
        }),
      })
      .parse(restored.structuredContent).after,
    { bottleId, status: "in_stock", storageLocationId: "left" },
  );
  assert.deepEqual(
    resultFlags.parse((await call("cellar.restore_bottle", { bottleId })).structuredContent),
    { changed: false, affectedRecordCount: 0 },
  );
  assert.notEqual(
    (
      await call("cellar.add_bottles", {
        siteId: "site",
        operationId: crypto.randomUUID(),
        wine: { wineryName: "Maker", designation: "Reserve" },
      })
    ).isError,
    true,
  );

  sqlite.exec("UPDATE site_memberships SET role='viewer'");
  assert.equal((await call("cellar.add_bottles", input)).isError, true);
  assert.equal((await call("cellar.restore_bottle", { bottleId })).isError, true);
});

await it("MCP photo corrections remain drafts until the browser confirms the saved revision", async (context) => {
  const { call, request, sqlite, userId, close } = await setup();
  context.after(close);
  sqlite.exec("INSERT INTO sites(id,name) VALUES ('private','Private')");
  const seed = sqlite.prepare(
    "INSERT INTO bottle_captures(id,site_id,user_id,status,quantity) VALUES (?,?,?,'needs_review',2)",
  );
  seed.run("capture", "site", userId);
  seed.run("hidden", "private", userId);
  const extraction = {
    wine: { wineryName: "Original", designation: "Reserve" },
    bottle: { volumeMl: 750 },
  };
  const issue = { path: "wine.vintageYear", rawValue: "202?", message: "Check year" };
  sqlite
    .prepare(`INSERT INTO bottle_capture_runs(id,capture_id,status,extractor_version,prompt_version,schema_version,import_candidate_json,extraction_r2_key)
    VALUES ('run','capture','needs_review','test','v1','v1',?,'internal-key')`)
    .run(
      JSON.stringify({
        ...extraction,
        validationIssues: [issue],
        rawSuggestion: { private: "internal-artifact" },
      }),
    );
  const list = await call("cellar.list_captures", {});
  assert.deepEqual(
    z
      .object({ captures: z.array(z.object({ captureId: z.string() })) })
      .parse(list.structuredContent).captures,
    [{ captureId: "capture" }],
  );
  assert.equal((await call("cellar.get_capture_review", { captureId: "hidden" })).isError, true);
  const content = z.record(z.string(), z.unknown());
  const read = content.parse(
    (await call("cellar.get_capture_review", { captureId: "capture" })).structuredContent,
  );
  assert.deepEqual(read["extractedCandidate"], extraction);
  assert.deepEqual(read["extractionIssues"], [issue]);
  assert.equal(read["reviewRevision"], 0);
  assert.equal(read["confirmationUrl"], "http://localhost/?area=captures");
  assert.doesNotMatch(JSON.stringify(read), /internal-key|internal-artifact/u);
  const candidate = {
    ...extraction,
    wine: { ...extraction.wine, wineryName: "Corrected", vintageYear: 2021 },
  };
  const save = { captureId: "capture", expectedRevision: 0, candidate };
  assert.equal(
    (await call("cellar.save_capture_review", { ...save, captureId: "hidden" })).isError,
    true,
  );
  sqlite.exec("UPDATE site_memberships SET role='viewer'");
  assert.equal((await call("cellar.save_capture_review", save)).isError, true);
  sqlite.exec("UPDATE site_memberships SET role='editor'");
  sqlite.exec(
    "CREATE TRIGGER fail_capture_audit BEFORE UPDATE ON mcp_tool_audit_events BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END",
  );
  assert.equal((await call("cellar.save_capture_review", save)).isError, true);
  assert.equal(
    sqlite.prepare("SELECT review_revision FROM bottle_captures WHERE id='capture'").get()?.[
      "review_revision"
    ],
    0,
  );
  sqlite.exec("DROP TRIGGER fail_capture_audit");
  const saved = await call("cellar.save_capture_review", save);
  assert.notEqual(saved.isError, true, JSON.stringify(saved));
  assert.deepEqual(content.parse(saved.structuredContent)["after"], {
    status: "needs_review",
    reviewRevision: 1,
  });
  assert.equal((await call("cellar.save_capture_review", save)).isError, true);
  const reread = content.parse(
    (await call("cellar.get_capture_review", { captureId: "capture" })).structuredContent,
  );
  assert.deepEqual(reread["reviewCandidate"], candidate);
  assert.deepEqual(reread["extractedCandidate"], extraction);
  assert.equal(
    sqlite
      .prepare(
        "SELECT count(*) AS n FROM mcp_tool_audit_events WHERE tool_name='cellar.save_capture_review' AND target_persisted_id='capture'",
      )
      .get()?.["n"],
    1,
  );
  assert.equal(
    (await request("/bottle-captures/capture/import", "POST", { expectedReviewRevision: 0 }))
      .status,
    409,
  );
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM bottles").get()?.["n"], 1);
  const imported = await request("/bottle-captures/capture/import", "POST", {
    expectedReviewRevision: 1,
  });
  assert.equal(imported.status, 200, await imported.clone().text());
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM bottles").get()?.["n"], 3);
  assert.equal(
    sqlite
      .prepare(
        "SELECT count(*) AS n FROM bottles JOIN wine_vintages ON bottles.wine_vintage_id=wine_vintages.id JOIN wineries ON wine_vintages.winery_id=wineries.id WHERE wineries.name='Corrected' AND wine_vintages.vintage_year=2021",
      )
      .get()?.["n"],
    2,
  );
  assert.equal(
    (await call("cellar.save_capture_review", { ...save, expectedRevision: 1 })).isError,
    true,
  );
});
