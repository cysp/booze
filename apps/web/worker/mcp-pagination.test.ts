// oxlint-disable import/max-dependencies -- Exercises pagination through every SQL-backed list interface.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createD1Client } from "@chikachow/booze-db";
import { z } from "zod";

import { asD1, migratedDatabase } from "./d1-support.ts";
import { listBottleSummaries } from "./mcp/bottles.ts";
import { decodePageCursor, pageFromRows, type Page } from "./read-pagination.ts";
import { listSites } from "./mcp/sites.ts";
import { listStorageLocations } from "./mcp/storage-locations.ts";
import { listWineries } from "./mcp/wineries.ts";
import { listWineVintages } from "./mcp/wines.ts";
import {
  listSitesInputSchema,
  listStorageLocationsInputSchema,
  listWineriesInputSchema,
  listWinesInputSchema,
  searchBottlesInputSchema,
} from "./mcp/schemas.ts";

await describe("MCP pagination over stored international names", async () => {
  await it("round-trips Unicode and accepts its own long tokens without breaking v1 tokens", () => {
    const name = "É蓮🍷".repeat(80);
    const page = pageFromRows({
      cursorForItem: (item: string) => ({ name: item }),
      input: { limit: 1 },
      items: [name, "next"],
      toolName: "cellar.list_sites",
    });
    const input = listSitesInputSchema.parse({ limit: 1, pageToken: page.metadata.nextPageToken });
    const cursorSchema = z.object({ name: z.string() });
    assert.deepEqual(decodePageCursor({ cursorSchema, input, toolName: "cellar.list_sites" }), {
      name,
    });
    // This is the original Latin-1 encoder used before this audit.
    const legacyToken = btoa(
      JSON.stringify({ ...JSON.parse(atob(input.pageToken ?? "")), cursor: { name: "École" } }),
    );
    assert.deepEqual(
      decodePageCursor({
        cursorSchema,
        input: { ...input, pageToken: legacyToken },
        toolName: "cellar.list_sites",
      }),
      { name: "École" },
    );
  });

  for (const name of ["Étage", "蓮🍷", "É".repeat(180)]) {
    await it(`visits every authorized row once with name ${name.slice(0, 10)}`, async () => {
      const sqlite = migratedDatabase();
      sqlite.exec("INSERT INTO users (id, clerk_user_id) VALUES ('user-1', 'clerk-1')");
      for (const id of ["1", "2", "3"]) {
        sqlite.prepare("INSERT INTO sites (id, name) VALUES (?, ?)").run(id, name.slice(0, 80));
        sqlite
          .prepare(
            "INSERT INTO site_memberships (site_id, user_id, role) VALUES (?, 'user-1', 'owner')",
          )
          .run(id);
        sqlite
          .prepare("INSERT INTO wineries (id, site_id, name) VALUES (?, ?, ?)")
          .run(id, id, name.slice(0, 160));
        sqlite
          .prepare(
            "INSERT INTO wine_vintages (id, site_id, winery_id, base_name, display_name, vintage_label) VALUES (?, ?, ?, ?, ?, 'NV')",
          )
          .run(id, id, id, name, name);
        sqlite
          .prepare("INSERT INTO bottles (id, site_id, wine_vintage_id) VALUES (?, ?, ?)")
          .run(id, id, id);
        sqlite
          .prepare("INSERT INTO storage_locations (id, site_id, name) VALUES (?, ?, ?)")
          .run(id, id, name.slice(0, 120));
      }
      const database = createD1Client(asD1(sqlite));
      const scope = { database, userId: "user-1" };
      const listers: readonly ((pageToken?: string) => Promise<Page<unknown>>)[] = [
        async (pageToken) =>
          listSites({ ...scope, input: listSitesInputSchema.parse({ limit: 1, pageToken }) }),
        async (pageToken) =>
          listWineVintages({
            ...scope,
            input: listWinesInputSchema.parse({ limit: 1, pageToken }),
          }),
        async (pageToken) =>
          listWineries({ ...scope, input: listWineriesInputSchema.parse({ limit: 1, pageToken }) }),
        async (pageToken) =>
          listStorageLocations({
            ...scope,
            input: listStorageLocationsInputSchema.parse({ limit: 1, pageToken }),
          }),
        async (pageToken) =>
          listBottleSummaries({
            ...scope,
            storageLocationId: undefined,
            input: searchBottlesInputSchema.parse({ limit: 1, pageToken }),
          }),
      ];
      for (const list of listers) {
        let pageToken: string | undefined;
        const items: unknown[] = [];
        for (let pageNumber = 0; pageNumber < 4; pageNumber += 1) {
          const page = await list(pageToken);
          items.push(...page.items);
          if (!page.metadata.hasMore) break;
          assert.notEqual(page.metadata.nextPageToken, null);
          if (page.metadata.nextPageToken === null) throw new Error("Missing continuation token");
          pageToken = page.metadata.nextPageToken;
        }
        assert.equal(items.length, 3);
        assert.equal(new Set(items.map((item) => JSON.stringify(item))).size, 3);
      }
      sqlite.close();
    });
  }
});
