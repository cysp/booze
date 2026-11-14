import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { Hono } from "hono";

import { problemResponseForError } from "./api/http.ts";
import { userIdForClerkUser } from "./api/ids.ts";
import type { Bindings } from "./api/types.ts";
import { asD1, migratedDatabase } from "./d1-support.ts";
import { storageLocationRoutes } from "./routes/storage-locations.ts";

function cellar(): DatabaseSync {
  const sqlite = migratedDatabase();
  const userId = userIdForClerkUser("dev:owner");
  sqlite.prepare("INSERT INTO users (id, clerk_user_id) VALUES (?, 'dev:owner')").run(userId);
  sqlite.exec("INSERT INTO sites (id, name) VALUES ('site', 'Cellar')");
  sqlite
    .prepare("INSERT INTO site_memberships (site_id, user_id, role) VALUES ('site', ?, 'owner')")
    .run(userId);
  sqlite.exec(`
    INSERT INTO storage_locations (id, site_id, name) VALUES ('rack', 'site', 'Rack');
    INSERT INTO storage_locations (id, site_id, parent_id, name) VALUES ('shelf', 'site', 'rack', 'Shelf');
    INSERT INTO wineries (id, site_id, name) VALUES ('winery', 'site', 'Winery');
    INSERT INTO wine_vintages (id, site_id, winery_id, base_name, display_name, vintage_label) VALUES ('wine', 'site', 'winery', 'Wine', 'Wine', 'NV');
    INSERT INTO bottles (id, site_id, wine_vintage_id, status) VALUES ('available', 'site', 'wine', 'in_stock'), ('consumed', 'site', 'wine', 'consumed');
    INSERT INTO bottle_locations (bottle_id, site_id, storage_location_id, position_hint) VALUES ('available', 'site', 'rack', 'A1'), ('consumed', 'site', 'rack', 'A2');
  `);
  sqlite
    .prepare(
      "INSERT INTO bottle_captures (id, site_id, user_id, storage_location_id, position_hint, status) VALUES ('capture', 'site', ?, 'rack', 'A3', 'needs_review')",
    )
    .run(userId);
  return sqlite;
}

async function request(
  sqlite: DatabaseSync,
  method: string,
  path = "/storage-locations/rack",
  body?: Record<string, unknown>,
): Promise<Response> {
  const app = new Hono<{ Bindings: Bindings }>();
  app.route("/", storageLocationRoutes);
  app.onError(problemResponseForError);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- These routes use only D1 and local authentication.
  const bindings = { DB: asD1(sqlite) } as Bindings;
  return app.request(
    `http://localhost${path}`,
    {
      method,
      headers: { "x-dev-user": "owner", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    bindings,
  );
}

await describe("storage location integrity", async () => {
  await it("requires an explicit site ID without creating a default or named site", async () => {
    const sqlite = cellar();
    for (const body of [{ name: "Box" }, { siteName: "New site", name: "Box" }]) {
      assert.equal((await request(sqlite, "POST", "/storage-locations", body)).status, 400);
    }
    assert.equal(sqlite.prepare("SELECT count(*) AS count FROM sites").get()?.["count"], 1);
    assert.equal(
      sqlite.prepare("SELECT count(*) AS count FROM storage_locations").get()?.["count"],
      2,
    );
    assert.equal(
      sqlite.prepare("SELECT count(*) AS count FROM mcp_tool_audit_events").get()?.["count"],
      0,
    );
    sqlite.close();
  });

  await it("rejects self, descendant, missing, and cross-site parents without changing the hierarchy", async () => {
    const sqlite = cellar();
    sqlite.exec(
      "INSERT INTO sites (id, name) VALUES ('other', 'Other'); INSERT INTO storage_locations (id, site_id, name) VALUES ('other-rack', 'other', 'Other rack')",
    );
    for (const parentId of ["rack", "shelf", "missing", "other-rack"]) {
      const response = await request(sqlite, "PATCH", "/storage-locations/rack", {
        parentId,
        name: "Should not be saved",
      });
      assert.equal(response.status, 400, parentId);
      assert.deepEqual(
        {
          ...sqlite
            .prepare("SELECT parent_id, name FROM storage_locations WHERE id = 'rack'")
            .get(),
        },
        { parent_id: null, name: "Rack" },
      );
    }
    assert.equal(
      (
        await request(sqlite, "POST", "/storage-locations", {
          siteId: "site",
          name: "Box",
          parentId: "other-rack",
        })
      ).status,
      400,
    );
    assert.equal(
      (await request(sqlite, "PATCH", "/storage-locations/shelf", { parentId: null })).status,
      200,
    );
    assert.equal(
      (await request(sqlite, "PATCH", "/storage-locations/rack", { parentId: "shelf" })).status,
      200,
    );
    assert.equal(
      sqlite.prepare("SELECT parent_id FROM storage_locations WHERE id = 'rack'").get()?.[
        "parent_id"
      ],
      "shelf",
    );
    sqlite.close();
  });

  await it("deletes a location while preserving captures, bottles, and their site", async () => {
    const sqlite = cellar();
    assert.equal((await request(sqlite, "DELETE")).status, 204);
    assert.equal(
      sqlite.prepare("SELECT count(*) AS count FROM bottles WHERE site_id = 'site'").get()?.[
        "count"
      ],
      2,
    );
    assert.equal(
      sqlite.prepare("SELECT count(*) AS count FROM bottle_locations").get()?.["count"],
      0,
    );
    assert.deepEqual(
      {
        ...sqlite
          .prepare(
            "SELECT site_id, storage_location_id, position_hint, status FROM bottle_captures",
          )
          .get(),
      },
      {
        site_id: "site",
        storage_location_id: null,
        position_hint: null,
        status: "needs_review",
      },
    );
    assert.equal(
      sqlite.prepare("SELECT parent_id FROM storage_locations WHERE id = 'shelf'").get()?.[
        "parent_id"
      ],
      null,
    );
    assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
    sqlite.close();
  });

  await it("rolls back all position changes when deleting the location fails", async () => {
    const sqlite = cellar();
    sqlite.exec(
      "CREATE TRIGGER reject_location_delete BEFORE DELETE ON storage_locations BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END",
    );
    assert.equal((await request(sqlite, "DELETE")).status, 500);
    assert.equal(
      sqlite
        .prepare("SELECT position_hint FROM bottle_locations WHERE bottle_id = 'available'")
        .get()?.["position_hint"],
      "A1",
    );
    assert.equal(
      sqlite.prepare("SELECT storage_location_id FROM bottle_captures").get()?.[
        "storage_location_id"
      ],
      "rack",
    );
    assert.equal(
      sqlite.prepare("SELECT parent_id FROM storage_locations WHERE id = 'shelf'").get()?.[
        "parent_id"
      ],
      "rack",
    );
    sqlite.close();
  });

  await it("counts only available bottles at a location", async () => {
    const sqlite = cellar();
    const response = await request(sqlite, "GET", "/storage-locations");
    assert.equal(response.status, 200);
    const body: unknown = await response.json();
    assert.deepEqual(body, {
      data: [
        {
          id: "rack",
          siteId: "site",
          siteName: "Cellar",
          parentId: null,
          name: "Rack",
          locationType: "area",
          bottleCount: 1,
        },
        {
          id: "shelf",
          siteId: "site",
          siteName: "Cellar",
          parentId: "rack",
          name: "Shelf",
          locationType: "area",
          bottleCount: 0,
        },
      ],
    });
    sqlite.close();
  });
});
