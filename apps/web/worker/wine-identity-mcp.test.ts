import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createD1Client } from "@chikachow/booze-db";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import { asD1, migratedDatabase } from "./d1-support.ts";
import { createBoozeMcpServer } from "./mcp/server.ts";
import {
  bottleOutputSchema,
  bottleSummaryOutputSchema,
  paginationOutputSchema,
  wineVintageSummaryOutputSchema,
} from "./mcp/schemas.ts";

const wineSchema = z.strictObject(wineVintageSummaryOutputSchema);
const bottleSchema = z.strictObject(bottleSummaryOutputSchema);
const winesPageSchema = z.strictObject({ ...paginationOutputSchema, wines: z.array(wineSchema) });
const bottlesPageSchema = z.strictObject({
  ...paginationOutputSchema,
  bottles: z.array(bottleSchema),
});

function identityDatabase() {
  const sqlite = migratedDatabase();
  sqlite.exec(`
    INSERT INTO users (id, clerk_user_id) VALUES ('reader', 'reader');
    INSERT INTO sites (id, name) VALUES ('visible', 'Home'), ('private', 'Private');
    INSERT INTO site_memberships (site_id, user_id, role) VALUES ('visible', 'reader', 'viewer');
    INSERT INTO wineries (id, site_id, name) VALUES ('producer', 'visible', 'Known producer');
    INSERT INTO wine_vintages (id, site_id, winery_id, base_name, display_name, vintage_label)
      VALUES ('unknown-a', 'visible', NULL, '', 'Unidentified wine', 'NV'),
             ('unknown-b', 'visible', NULL, '', 'Unidentified wine', 'Unknown'),
             ('known', 'visible', 'producer', '', 'Known wine', 'Unknown'),
             ('hidden', 'private', NULL, '', 'Private unidentified wine', 'NV');
    INSERT INTO wine_vintages (id, site_id, base_name, display_name, vintage_year, vintage_label)
      VALUES ('year', 'visible', '', 'Unidentified wine', 2022, 'NV');
    INSERT INTO wine_vintages (id, site_id, base_name, display_name, vintage_status, vintage_label)
      VALUES ('non-vintage', 'visible', '', 'Unidentified wine', 'non_vintage', 'Unknown');
    INSERT INTO bottles (id, site_id, wine_vintage_id)
      VALUES ('bottle-unknown-a', 'visible', 'unknown-a'),
             ('bottle-unknown-a-second', 'visible', 'unknown-a'),
             ('bottle-unknown-b', 'visible', 'unknown-b'),
             ('bottle-year', 'visible', 'year'),
             ('bottle-nv', 'visible', 'non-vintage'),
             ('bottle-known', 'visible', 'known'),
             ('bottle-hidden', 'private', 'hidden');
  `);
  return sqlite;
}

async function withIdentityClient(run: (client: Client) => Promise<void>): Promise<void> {
  const sqlite = identityDatabase();
  const server = createBoozeMcpServer({ database: createD1Client(asD1(sqlite)), userId: "reader" });
  const client = new Client({ name: "wine-identity-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    // Loads the advertised output schemas so SDK validation also runs on calls.
    await client.listTools();
    await run(client);
  } finally {
    await client.close();
    await server.close();
    sqlite.close();
  }
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<unknown> {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.notEqual(result.structuredContent, undefined);
  return result.structuredContent;
}

await describe("MCP wine identity reads", async () => {
  await it("paginates every authorized unidentified wine and bottle with strict output schemas", async () => {
    await withIdentityClient(async (client) => {
      const wines: z.infer<typeof wineSchema>[] = [];
      let pageToken: string | undefined;
      for (let index = 0; index < 6; index += 1) {
        const page = winesPageSchema.parse(
          await call(client, "cellar.list_wines", { limit: 1, pageToken }),
        );
        assert.equal(page.returnedCount, 1);
        wines.push(...page.wines);
        if (!page.hasMore) {
          assert.equal(page.nextPageToken, null);
          break;
        }
        assert.notEqual(page.nextPageToken, null);
        pageToken = page.nextPageToken ?? undefined;
      }
      assert.deepEqual(
        new Set(wines.map((wine) => wine.wineId)),
        new Set(["unknown-a", "unknown-b", "year", "non-vintage", "known"]),
      );
      assert.equal(wines.length, 5);
      assert.equal(wines.filter((wine) => wine.wineryId === null && wine.winery === "").length, 4);
      assert.equal(wines.find((wine) => wine.wineId === "unknown-a")?.bottleCount, 2);

      const bottles: z.infer<typeof bottleSchema>[] = [];
      pageToken = undefined;
      for (let index = 0; index < 7; index += 1) {
        const page = bottlesPageSchema.parse(
          await call(client, "cellar.search_bottles", { limit: 1, pageToken }),
        );
        assert.equal(page.returnedCount, 1);
        bottles.push(...page.bottles);
        if (!page.hasMore) {
          assert.equal(page.nextPageToken, null);
          break;
        }
        assert.notEqual(page.nextPageToken, null);
        pageToken = page.nextPageToken ?? undefined;
      }
      assert.deepEqual(
        new Set(bottles.map((bottle) => bottle.bottleId)),
        new Set([
          "bottle-unknown-a",
          "bottle-unknown-a-second",
          "bottle-unknown-b",
          "bottle-year",
          "bottle-nv",
          "bottle-known",
        ]),
      );
      assert.equal(bottles.length, 6);
      assert.equal(
        bottles.filter((bottle) => bottle.wineryId === null && bottle.winery === "").length,
        5,
      );
    });
  });

  await it("distinguishes unknown, explicit NV and recorded year on list and detail reads", async () => {
    await withIdentityClient(async (client) => {
      const winePage = winesPageSchema.parse(
        await call(client, "cellar.list_wines", { limit: 20 }),
      );
      const bottlePage = bottlesPageSchema.parse(
        await call(client, "cellar.search_bottles", { limit: 20 }),
      );
      for (const expectation of [
        { id: "unknown-a", bottleId: "bottle-unknown-a", label: "Unknown", year: null },
        { id: "unknown-b", bottleId: "bottle-unknown-b", label: "Unknown", year: null },
        { id: "non-vintage", bottleId: "bottle-nv", label: "NV", year: null },
        { id: "year", bottleId: "bottle-year", label: "2022", year: 2022 },
      ]) {
        const wineId = expectation.id;
        const wineDetail = z
          .strictObject({ wine: wineSchema, wineId: z.string() })
          .parse(await call(client, "cellar.get_wine", { wineId }));
        const bottleDetail = z
          .strictObject({ bottle: z.strictObject(bottleOutputSchema) })
          .parse(await call(client, "cellar.get_bottle", { bottleId: expectation.bottleId }));
        for (const row of [
          winePage.wines.find((wine) => wine.wineId === wineId),
          wineDetail.wine,
          bottlePage.bottles.find((bottle) => bottle.bottleId === expectation.bottleId),
          bottleDetail.bottle,
        ]) {
          assert.notEqual(row, undefined);
          assert.equal(row?.vintageLabel, expectation.label);
          assert.equal(row?.vintageYear, expectation.year);
          assert.equal(row?.wineryId, null);
          assert.equal(row?.winery, "");
          assert.equal(row?.wine, "Unidentified wine");
        }
      }
    });
  });

  await it("searches the effective vintage label instead of an old writer's stale NV label", async () => {
    await withIdentityClient(async (client) => {
      const wines = winesPageSchema.parse(
        await call(client, "cellar.list_wines", { query: "NV", limit: 20 }),
      );
      const bottles = bottlesPageSchema.parse(
        await call(client, "cellar.search_bottles", { query: "NV", limit: 20 }),
      );
      assert.deepEqual(
        wines.wines.map((wine) => wine.wineId),
        ["non-vintage"],
      );
      assert.deepEqual(
        bottles.bottles.map((bottle) => bottle.bottleId),
        ["bottle-nv"],
      );
    });
  });
});
