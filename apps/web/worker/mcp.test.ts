// oxlint-disable import/max-dependencies -- MCP contract test intentionally covers the complete public tool surface.
import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Hono } from "hono";
import { createD1Client } from "@chikachow/booze-db";
import { z } from "zod";

import { problemResponseForError } from "./api/http.ts";
import { calculateDrinkStatus } from "./api/inventory.ts";
import { mcpToolAuditEventInputSchema } from "./mcp/audit.ts";
import { decodePageCursor, pageFromRows, rowsAfterCursor, toolJson } from "./mcp/pagination.ts";
import {
  drinkQueueStatuses,
  createReviewSourceInputSchema,
  createStorageLocationInputSchema,
  deleteCriticReviewInputSchema,
  getWineInputSchema,
  listCriticReviewsInputSchema,
  listDrinkQueueInputSchema,
  listReviewSourcesInputSchema,
  listSitesInputSchema,
  listStorageLocationsInputSchema,
  listWinesInputSchema,
  listWineriesInputSchema,
  locationInventoryInputSchema,
  markBottleConsumedInputSchema,
  searchBottlesInputSchema,
  setBottleLocationInputSchema,
  setDrinkingWindowInputSchema,
  upsertCriticReviewInputSchema,
} from "./mcp/schemas.ts";
import { boozeMcpToolNames, createBoozeMcpServer } from "./mcp/server.ts";
import { clerkOAuthScopes, clerkOAuthSubject, mcpRoutes } from "./routes/mcp.ts";
import type { Bindings } from "./api/types.ts";

function rawD1Rows<T = unknown[]>(options: {
  readonly columnNames: true;
}): Promise<[string[], ...T[]]>;
function rawD1Rows<T = unknown[]>(options?: { readonly columnNames?: false }): Promise<T[]>;
async function rawD1Rows(): Promise<never> {
  throw new Error("unexpected D1 raw");
}

function fakeD1PreparedStatement({
  runErrorMessage,
}: {
  readonly runErrorMessage?: string;
}): D1PreparedStatement {
  const statement: D1PreparedStatement = {
    bind(): D1PreparedStatement {
      return statement;
    },
    async all(): Promise<never> {
      throw new Error("unexpected D1 all");
    },
    async first(): Promise<never> {
      throw new Error("unexpected D1 first");
    },
    raw: rawD1Rows,
    async run(): Promise<never> {
      throw new Error(runErrorMessage ?? "unexpected D1 run");
    },
  };
  return statement;
}

function fakeD1Session(options: { readonly runErrorMessage?: string }): D1DatabaseSession {
  return {
    async batch<T = unknown>(): Promise<D1Result<T>[]> {
      throw new Error("unexpected D1 session batch");
    },
    getBookmark(): D1SessionBookmark | null {
      return null;
    },
    prepare(): D1PreparedStatement {
      return fakeD1PreparedStatement(options);
    },
  };
}

function fakeD1Database(options: { readonly runErrorMessage?: string } = {}): D1Database {
  return {
    async batch<T = unknown>(): Promise<D1Result<T>[]> {
      throw new Error("unexpected D1 batch");
    },
    async dump(): Promise<ArrayBuffer> {
      throw new Error("unexpected D1 dump");
    },
    async exec(): Promise<D1ExecResult> {
      throw new Error("unexpected D1 exec");
    },
    prepare(): D1PreparedStatement {
      return fakeD1PreparedStatement(options);
    },
    withSession(): D1DatabaseSession {
      return fakeD1Session(options);
    },
  };
}

function testBindings(overrides: Partial<Bindings> = {}): Bindings {
  return {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- MCP tests never invoke the workflow binding.
    BOTTLE_CAPTURE_WORKFLOW: {} as Workflow,
    DB: fakeD1Database(),
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- MCP tests never invoke the R2 binding.
    IMAGE_BUCKET: {} as R2Bucket,
    CLERK_OAUTH_ISSUER: "https://clerk.example",
    CLERK_SECRET_KEY: "sk_test_placeholder",
    ...overrides,
  };
}

async function listRegisteredMcpTools(): Promise<
  Awaited<ReturnType<Client["listTools"]>>["tools"]
> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "booze-test-client", version: "0.0.0" });
  const server = createBoozeMcpServer({
    database: createD1Client(fakeD1Database()),
    userId: "user_test",
  });

  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const result = await client.listTools();
  await client.close();
  return result.tools;
}

type ListedMcpTool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];

function requireTool(tools: readonly ListedMcpTool[], toolName: string): ListedMcpTool {
  const tool = tools.find((candidate) => candidate.name === toolName);
  if (tool === undefined) {
    throw new Error(`Expected MCP tool ${toolName}`);
  }
  return tool;
}

function assertWriteToolHidesAuditId(tool: ListedMcpTool): void {
  assert.equal(tool.annotations?.readOnlyHint, false);
  assert.equal("auditEventId" in (tool.outputSchema?.properties ?? {}), false);
}

function testApp(): Hono<{ Bindings: Bindings }> {
  const app = new Hono<{ Bindings: Bindings }>();
  app.route("/", mcpRoutes);
  app.onError(problemResponseForError);
  return app;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function jsonSchemaPropertyDescription(schema: unknown, propertyName: string): unknown {
  if (!isObjectRecord(schema) || !isObjectRecord(schema["properties"])) {
    return undefined;
  }
  const property = schema["properties"][propertyName];
  if (!isObjectRecord(property)) {
    return undefined;
  }
  return property["description"];
}

function hasString(values: readonly string[], value: string): boolean {
  return values.includes(value);
}

await test("calculateDrinkStatus classifies drink windows", () => {
  const now = new Date("2026-06-02T00:00:00.000Z");

  assert.equal(calculateDrinkStatus({ drinkFromYear: null, drinkToYear: null, now }), "unknown");
  assert.equal(calculateDrinkStatus({ drinkFromYear: 2028, drinkToYear: 2032, now }), "hold");
  assert.equal(
    calculateDrinkStatus({ drinkFromYear: 2018, drinkToYear: 2025, now }),
    "past-window",
  );
  assert.equal(calculateDrinkStatus({ drinkFromYear: 2020, drinkToYear: 2028, now }), "drink-soon");
  assert.equal(calculateDrinkStatus({ drinkFromYear: 2020, drinkToYear: 2032, now }), "drink-now");
});

await test("MCP tool input schemas enforce bounded limits", () => {
  assert.equal(searchBottlesInputSchema.parse({}).limit, 10);
  assert.equal(searchBottlesInputSchema.parse({}).pageToken, undefined);
  assert.equal(listSitesInputSchema.parse({}).limit, 10);
  assert.equal(listStorageLocationsInputSchema.parse({}).limit, 10);
  assert.equal(listWinesInputSchema.parse({}).limit, 10);
  assert.equal(listWineriesInputSchema.parse({}).limit, 10);
  assert.equal(listReviewSourcesInputSchema.parse({}).limit, 10);
  assert.equal(listReviewSourcesInputSchema.parse({}).includeInactive, false);
  assert.equal(listCriticReviewsInputSchema.parse({}).limit, 10);
  assert.deepEqual(listDrinkQueueInputSchema.parse({}).drinkStatuses, drinkQueueStatuses);
  assert.equal(listDrinkQueueInputSchema.parse({}).limit, 10);
  assert.equal(locationInventoryInputSchema.parse({ locationId: "rack-a" }).limit, 10);
  assert.equal(
    createStorageLocationInputSchema.parse({ siteId: "site_home", name: "left rack" }).locationType,
    "area",
  );
  assert.deepEqual(
    setBottleLocationInputSchema.parse({
      bottleId: "bottle_1",
      storageLocationId: null,
    }),
    { bottleId: "bottle_1", storageLocationId: null },
  );
  assert.deepEqual(markBottleConsumedInputSchema.parse({ bottleId: "bottle_1" }), {
    bottleId: "bottle_1",
  });
  assert.equal(
    createReviewSourceInputSchema.parse({ siteId: "site_home", name: "Halliday" }).sourceType,
    "critic",
  );
  assert.deepEqual(
    upsertCriticReviewInputSchema.parse({
      wineId: "wine_abc",
      reviewSourceName: "Halliday",
      ratingText: "95 points",
    }),
    {
      wineId: "wine_abc",
      reviewSourceName: "Halliday",
      ratingText: "95 points",
    },
  );
  assert.deepEqual(deleteCriticReviewInputSchema.parse({ criticReviewId: "review_abc" }), {
    criticReviewId: "review_abc",
  });

  assert.throws(() => searchBottlesInputSchema.parse({ limit: 26 }));
  assert.throws(() => listSitesInputSchema.parse({ limit: 26 }));
  assert.throws(() => listStorageLocationsInputSchema.parse({ limit: 26 }));
  assert.throws(() => listWinesInputSchema.parse({ limit: 26 }));
  assert.throws(() => listWineriesInputSchema.parse({ limit: 26 }));
  assert.throws(() => listReviewSourcesInputSchema.parse({ limit: 26 }));
  assert.throws(() => listCriticReviewsInputSchema.parse({ limit: 26 }));
  assert.throws(() => listDrinkQueueInputSchema.parse({ limit: 0 }));
  assert.throws(() => listDrinkQueueInputSchema.parse({ offset: 1 }));
  assert.throws(() => listDrinkQueueInputSchema.parse({ drinkStatuses: [] }));
  assert.throws(() => getWineInputSchema.parse({}));
  assert.throws(() => locationInventoryInputSchema.parse({ locationId: "", limit: 1 }));
  assert.throws(() => createStorageLocationInputSchema.parse({ siteId: "site_home", name: "" }));
  assert.throws(() => createReviewSourceInputSchema.parse({ siteId: "site_home", name: "" }));
  assert.throws(() =>
    upsertCriticReviewInputSchema.parse({ wineId: "wine_abc", reviewSourceName: "Halliday" }),
  );
  assert.throws(() =>
    setBottleLocationInputSchema.parse({ bottleId: "", storageLocationId: "location_1" }),
  );
});

await test("MCP tool input schemas reject unknown parameters", () => {
  assert.throws(() => searchBottlesInputSchema.parse({ wineryName: "legacy" }));
  assert.throws(() => listWinesInputSchema.parse({ brandName: "legacy" }));
  assert.throws(() => listWinesInputSchema.parse({ wineId: "wine_abc" }));
  assert.throws(() => listReviewSourcesInputSchema.parse({ sourceName: "legacy" }));
  assert.throws(() => listCriticReviewsInputSchema.parse({ wineVintageId: "legacy" }));
  assert.throws(() => listWineriesInputSchema.parse({ random: "ignored before" }));
  assert.throws(() => listDrinkQueueInputSchema.parse({ limit: 10, typo: true }));
  assert.throws(() =>
    createStorageLocationInputSchema.parse({
      siteId: "site_home",
      name: "rack",
      auditEventId: true,
    }),
  );
});

await test("MCP pagination uses opaque page tokens", () => {
  const cursorSchema = z.strictObject({ item: z.string() });
  const firstInput = { limit: 2, query: "red" };
  const firstPage = pageFromRows({
    cursorForItem: (item) => ({ item }),
    input: firstInput,
    items: ["a", "b", "c"],
    toolName: "test.list",
  });

  assert.deepEqual(firstPage.items, ["a", "b"]);
  assert.equal(firstPage.metadata.hasMore, true);
  assert.equal(firstPage.metadata.returnedCount, 2);
  assert.match(firstPage.metadata.nextPageToken ?? "", /^[A-Za-z0-9+/=]+$/u);
  assert.deepEqual(
    decodePageCursor({
      cursorSchema,
      input: { ...firstInput, pageToken: firstPage.metadata.nextPageToken ?? undefined },
      toolName: "test.list",
    }),
    { item: "b" },
  );

  assert.throws(() =>
    decodePageCursor({
      cursorSchema,
      input: { limit: 2, pageToken: firstPage.metadata.nextPageToken ?? undefined, query: "white" },
      toolName: "test.list",
    }),
  );

  const secondPage = pageFromRows({
    cursorForItem: (item) => ({ item }),
    input: { ...firstInput, pageToken: firstPage.metadata.nextPageToken ?? undefined },
    items: ["c", "d"],
    toolName: "test.list",
  });
  assert.deepEqual(secondPage.items, ["c", "d"]);
  assert.deepEqual(secondPage.metadata, {
    hasMore: false,
    limit: 2,
    nextPageToken: null,
    returnedCount: 2,
  });
});

await test("MCP in-memory pagination advances past decoded cursor rows", () => {
  const items = [
    { id: "review_source_a", name: "James Suckling" },
    { id: "review_source_b", name: "Wine Companion" },
    { id: "review_source_c", name: "Winepilot" },
  ];

  assert.deepEqual(
    rowsAfterCursor({
      cursor: { reviewSourceId: "review_source_b" },
      cursorForItem: (item) => ({ reviewSourceId: item.id }),
      items,
    }),
    [{ id: "review_source_c", name: "Winepilot" }],
  );
  assert.throws(() =>
    rowsAfterCursor({
      cursor: { reviewSourceId: "review_source_missing" },
      cursorForItem: (item) => ({ reviewSourceId: item.id }),
      items,
    }),
  );
});

await test("MCP tool text content does not duplicate structured JSON", () => {
  const result = toolJson({
    hasMore: true,
    limit: 10,
    nextPageToken: "opaque",
    returnedCount: 10,
    wines: [{ wineId: "wine_abc", wine: "Example" }],
  });

  assert.deepEqual(result.structuredContent, {
    hasMore: true,
    limit: 10,
    nextPageToken: "opaque",
    returnedCount: 10,
    wines: [{ wineId: "wine_abc", wine: "Example" }],
  });
  assert.equal(
    result.content[0]?.text,
    "Returned 10 matching records with limit 10. Use nextPageToken for the next page.",
  );
  assert.doesNotMatch(result.content[0]?.text ?? "", /wineId/u);
});

await test("MCP server exposes the clean v1 tool surface", async () => {
  const tools = await listRegisteredMcpTools();
  const toolNames: readonly string[] = tools.map((tool) => tool.name).toSorted();

  assert.deepEqual(toolNames, [...boozeMcpToolNames].toSorted());
  assert.equal(hasString(toolNames, "cellar.list_drink_now"), false);
  assert.equal(hasString(toolNames, "cellar.list_drink_soon"), false);
  assert.equal(hasString(toolNames, "wine.search_bottles"), false);
  assert.equal(hasString(toolNames, "wine.get_location_inventory"), false);
});

await test("MCP tool metadata is complete", async () => {
  const tools = await listRegisteredMcpTools();
  for (const tool of tools) {
    assert.equal(typeof tool.title, "string", tool.name);
    assert.notEqual(tool.title, "", tool.name);
    assert.equal(typeof tool.description, "string", tool.name);
    assert.notEqual(tool.description, "", tool.name);
    assert.equal(tool.inputSchema.type, "object", tool.name);
    assert.equal(tool.outputSchema?.type, "object", tool.name);
    assert.equal(typeof tool.annotations?.readOnlyHint, "boolean", tool.name);
  }

  const listWines = tools.find((tool) => tool.name === "cellar.list_wines");
  const listWineProperties = listWines?.inputSchema.properties ?? {};
  assert.equal("wineId" in listWineProperties, false);
  assert.equal(typeof jsonSchemaPropertyDescription(listWines?.inputSchema, "siteId"), "string");
  assert.equal(typeof jsonSchemaPropertyDescription(listWines?.inputSchema, "pageToken"), "string");
});

await test("MCP write tool metadata is clear and hides audit IDs", async () => {
  const tools = await listRegisteredMcpTools();
  const setDrinkingWindow = requireTool(tools, "cellar.set_drinking_window");
  assertWriteToolHidesAuditId(setDrinkingWindow);
  assert.equal(setDrinkingWindow.annotations?.destructiveHint, true);
  assert.equal(setDrinkingWindow.annotations?.idempotentHint, true);
  assert.equal(setDrinkingWindow.annotations?.openWorldHint, false);

  assertWriteToolHidesAuditId(requireTool(tools, "cellar.create_storage_location"));
  assertWriteToolHidesAuditId(requireTool(tools, "cellar.create_review_source"));
  assertWriteToolHidesAuditId(requireTool(tools, "cellar.upsert_critic_review"));
  assertWriteToolHidesAuditId(requireTool(tools, "cellar.delete_critic_review"));
  assertWriteToolHidesAuditId(requireTool(tools, "cellar.set_bottle_location"));
  assertWriteToolHidesAuditId(requireTool(tools, "cellar.mark_bottle_consumed"));

  assert.equal(
    typeof jsonSchemaPropertyDescription(setDrinkingWindow?.inputSchema, "wineId"),
    "string",
  );
  assert.equal(
    typeof jsonSchemaPropertyDescription(setDrinkingWindow?.inputSchema, "drinkFromYear"),
    "string",
  );
  assert.equal(
    typeof jsonSchemaPropertyDescription(setDrinkingWindow?.inputSchema, "drinkToYear"),
    "string",
  );
});

await test("set drinking window input schema requires an ordered window", () => {
  assert.deepEqual(
    setDrinkingWindowInputSchema.parse({
      wineId: "wine_abc",
      drinkFromYear: 2026,
      drinkToYear: 2030,
    }),
    {
      wineId: "wine_abc",
      drinkFromYear: 2026,
      drinkToYear: 2030,
    },
  );
  assert.deepEqual(
    setDrinkingWindowInputSchema.parse({
      wineId: "wine_abc",
      drinkFromYear: null,
      drinkToYear: null,
    }),
    {
      wineId: "wine_abc",
      drinkFromYear: null,
      drinkToYear: null,
    },
  );
  assert.throws(() =>
    setDrinkingWindowInputSchema.parse({
      wineId: "wine_abc",
      drinkFromYear: 2030,
      drinkToYear: 2026,
    }),
  );
  assert.throws(() =>
    setDrinkingWindowInputSchema.parse({
      wineVintageId: "vintage-1",
      drinkFromYear: 2026,
      drinkToYear: 2030,
    }),
  );
});

await test("MCP audit event input schema accepts compact write audit payloads", () => {
  assert.deepEqual(
    mcpToolAuditEventInputSchema.parse({
      affectedRecordCount: 3,
      after: { drinkFromYear: 2026, drinkToYear: 2032, wineId: "wine_abc" },
      before: { drinkFromYear: null, drinkToYear: null, wineId: "wine_abc" },
      input: { drinkFromYear: 2026, drinkToYear: 2032, wineId: "wine_abc" },
      siteId: "site_home",
      targetKind: "wine",
      targetMcpId: "wine_abc",
      targetPersistedId: "vintage_home_abc",
      toolName: "cellar.set_drinking_window",
      userId: "user_abc",
    }),
    {
      affectedRecordCount: 3,
      after: { drinkFromYear: 2026, drinkToYear: 2032, wineId: "wine_abc" },
      before: { drinkFromYear: null, drinkToYear: null, wineId: "wine_abc" },
      input: { drinkFromYear: 2026, drinkToYear: 2032, wineId: "wine_abc" },
      siteId: "site_home",
      targetKind: "wine",
      targetMcpId: "wine_abc",
      targetPersistedId: "vintage_home_abc",
      toolName: "cellar.set_drinking_window",
      userId: "user_abc",
    },
  );
});

await test("Clerk OAuth verification response maps to a Clerk user subject", () => {
  assert.equal(clerkOAuthSubject({ subject: "user_subject" }), "user_subject");
  assert.equal(clerkOAuthSubject({ sub: "user_sub" }), "user_sub");
  assert.equal(clerkOAuthSubject({ user_id: "user_id" }), "user_id");
  assert.equal(clerkOAuthSubject({ user_id: "" }), null);
  assert.equal(clerkOAuthSubject(null), null);
});

await test("Clerk OAuth verification response maps scopes", () => {
  assert.deepEqual(
    [...clerkOAuthScopes({ scope: "email offline_access openid profile" })],
    ["email", "offline_access", "openid", "profile"],
  );
  assert.deepEqual([...clerkOAuthScopes({ scopes: ["email", "openid", 42] })], ["email", "openid"]);
  assert.deepEqual([...clerkOAuthScopes({ scope: "" })], []);
  assert.deepEqual([...clerkOAuthScopes(null)], []);
});

await test("MCP endpoint advertises protected resource metadata on missing auth", async () => {
  const response = await testApp().fetch(new Request("https://booze.example/mcp"), testBindings());

  assert.equal(response.status, 401);
  assert.equal(
    response.headers.get("www-authenticate"),
    'Bearer resource_metadata="https://booze.example/.well-known/oauth-protected-resource", scope="email offline_access openid profile"',
  );
});

await test("MCP protected resource metadata fails closed without Clerk OAuth issuer", async () => {
  const response = await testApp().fetch(
    new Request("https://booze.example/.well-known/oauth-protected-resource"),
    testBindings({ CLERK_OAUTH_ISSUER: "" }),
  );

  assert.equal(response.status, 503);
});

await test("MCP protected resource metadata advertises the configured Clerk issuer", async () => {
  const response = await testApp().fetch(
    new Request("https://booze.example/.well-known/oauth-protected-resource"),
    testBindings({ CLERK_OAUTH_ISSUER: "https://clerk.example/" }),
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body, {
    resource: "https://booze.example/mcp",
    resource_name: "Booze MCP",
    authorization_servers: ["https://clerk.example"],
    bearer_methods_supported: ["header"],
    scopes_supported: ["email", "offline_access", "openid", "profile"],
  });
});
