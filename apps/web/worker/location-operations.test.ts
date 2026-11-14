import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { createD1Client } from "@chikachow/booze-db";
import { HTTPException } from "hono/http-exception";

import { asD1, migratedDatabase } from "./d1-support.ts";
import {
  createStorageLocation,
  deleteStorageLocation,
  updateStorageLocation,
} from "./location-operations.ts";
import type { OperationContext } from "./operation-transaction.ts";

function cellar(): DatabaseSync {
  const sqlite = migratedDatabase();
  sqlite.exec(`
    INSERT INTO users (id, clerk_user_id) VALUES ('owner', 'owner');
    INSERT INTO sites (id, name) VALUES ('site', 'Cellar');
    INSERT INTO site_memberships (site_id, user_id, role) VALUES ('site', 'owner', 'owner');
  `);
  return sqlite;
}

function operationContext(sqlite: DatabaseSync, beforeBatch?: () => void): OperationContext {
  const d1 = asD1(sqlite);
  const batch = d1.batch.bind(d1);
  return {
    database: createD1Client(
      beforeBatch === undefined
        ? d1
        : Object.assign(d1, {
            async batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
              beforeBatch();
              return batch<T>(statements);
            },
          }),
    ),
    userId: "owner",
    source: "http",
  };
}

function rejectionStatus(status: number): (error: unknown) => boolean {
  return (error) => error instanceof HTTPException && error.status === status;
}

function count(sqlite: DatabaseSync, table: string): number {
  return Number(sqlite.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.["count"]);
}

function locations(sqlite: DatabaseSync): readonly Record<string, unknown>[] {
  return sqlite
    .prepare("SELECT * FROM storage_locations ORDER BY id")
    .all()
    .map((row) => ({ ...row }));
}

await describe("storage location operations", async () => {
  await it("serializes concurrent root creation and records an exact repeat as an unchanged operation", async () => {
    const sqlite = cellar();
    const context = operationContext(sqlite);
    const input = { siteId: "site", name: "Rack", locationType: "rack" };
    const results = await Promise.all([
      createStorageLocation({ context, input }),
      createStorageLocation({ context, input }),
    ]);
    assert.equal(results[0]?.after.id, results[1]?.after.id);
    assert.deepEqual(
      results.map((result) => result.affectedRecordCount).toSorted((left, right) => left - right),
      [0, 1],
    );
    assert.equal(count(sqlite, "storage_locations"), 1);
    assert.equal(count(sqlite, "mcp_tool_audit_events"), 2);
    const before = locations(sqlite);
    const repeated = await createStorageLocation({ context, input });
    assert.equal(repeated.changed, false);
    assert.deepEqual(repeated.before, repeated.after);
    assert.deepEqual(locations(sqlite), before);
    assert.equal(repeated.affectedRecordCount, 0);
    sqlite.close();
  });

  await it("keeps equal child names in different parents and exact-case names distinct", async () => {
    const sqlite = cellar();
    const context = operationContext(sqlite);
    const first = await createStorageLocation({ context, input: { siteId: "site", name: "Rack" } });
    const second = await createStorageLocation({
      context,
      input: { siteId: "site", name: "rack" },
    });
    const children = await Promise.all(
      [first, second].map(async (parent) =>
        createStorageLocation({
          context,
          input: { siteId: "site", parentId: parent.after.id, name: "Shelf" },
        }),
      ),
    );
    assert.notEqual(first.after.id, second.after.id);
    assert.notEqual(children[0]?.after.id, children[1]?.after.id);
    assert.equal(count(sqlite, "storage_locations"), 4);
    sqlite.close();
  });

  await it("preserves every historical duplicate root and requires an ID to resolve ambiguity", async () => {
    const sqlite = cellar();
    sqlite.exec(`INSERT INTO storage_locations (id, site_id, name, notes)
      VALUES ('legacy-1', 'site', 'Rack', 'one'), ('legacy-2', 'site', 'Rack', 'two')`);
    const before = locations(sqlite);
    await assert.rejects(
      createStorageLocation({
        context: operationContext(sqlite),
        input: { siteId: "site", name: "Rack" },
      }),
      rejectionStatus(409),
    );
    assert.deepEqual(locations(sqlite), before);
    assert.equal(count(sqlite, "mcp_tool_audit_events"), 0);
    const edited = await updateStorageLocation({
      context: operationContext(sqlite),
      storageLocationId: "legacy-1",
      input: { locationType: "rack", notes: "changed by ID" },
    });
    assert.equal(edited.after.id, "legacy-1");
    assert.equal(edited.after.locationType, "rack");
    assert.deepEqual(
      locations(sqlite).find((row) => row["id"] === "legacy-2"),
      before.find((row) => row["id"] === "legacy-2"),
    );
    assert.equal(count(sqlite, "storage_locations"), 2);
    sqlite.close();
  });

  await it("rejects a same-name type change until an explicit ID update", async () => {
    const sqlite = cellar();
    const context = operationContext(sqlite);
    const first = await createStorageLocation({ context, input: { siteId: "site", name: "Rack" } });
    const before = locations(sqlite);
    await assert.rejects(
      createStorageLocation({
        context,
        input: { siteId: "site", name: "Rack", locationType: "rack" },
      }),
      rejectionStatus(409),
    );
    assert.deepEqual(locations(sqlite), before);
    assert.equal(count(sqlite, "mcp_tool_audit_events"), 1);
    const updated = await updateStorageLocation({
      context,
      storageLocationId: first.after.id,
      input: { locationType: "rack" },
    });
    assert.equal(updated.after.locationType, "rack");
    assert.equal(updated.affectedRecordCount, 1);
    sqlite.close();
  });

  await it("checks missing and cross-site create parents inside the transaction", async () => {
    const sqlite = cellar();
    sqlite.exec(`INSERT INTO sites (id, name) VALUES ('other', 'Other');
      INSERT INTO storage_locations (id, site_id, name) VALUES ('other-rack', 'other', 'Rack')`);
    const before = locations(sqlite);
    for (const parentId of ["missing", "other-rack"]) {
      await assert.rejects(
        createStorageLocation({
          context: operationContext(sqlite),
          input: { siteId: "site", parentId, name: "Shelf" },
        }),
        rejectionStatus(400),
      );
    }
    assert.deepEqual(locations(sqlite), before);
    assert.equal(count(sqlite, "mcp_tool_audit_events"), 0);
    sqlite.close();
  });

  await it("checks destination names and concurrent cycle moves in the committing batch", async () => {
    const sqlite = cellar();
    sqlite.exec(`INSERT INTO storage_locations (id, site_id, name)
      VALUES ('a', 'site', 'A'), ('b', 'site', 'B')`);
    const context = operationContext(sqlite);
    await assert.rejects(
      updateStorageLocation({
        context,
        storageLocationId: "a",
        input: { name: "B" },
      }),
      rejectionStatus(409),
    );
    const moves = await Promise.allSettled([
      updateStorageLocation({ context, storageLocationId: "a", input: { parentId: "b" } }),
      updateStorageLocation({ context, storageLocationId: "b", input: { parentId: "a" } }),
    ]);
    assert.equal(moves.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = moves.find((result) => result.status === "rejected");
    assert.ok(rejected?.status === "rejected" && rejectionStatus(400)(rejected.reason));
    assert.equal(count(sqlite, "mcp_tool_audit_events"), 1);
    assert.equal(
      sqlite
        .prepare("SELECT count(*) AS count FROM storage_locations WHERE parent_id IS NULL")
        .get()?.["count"],
      1,
    );
    assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
    sqlite.close();
  });

  await it("serializes concurrent renames to a new root name", async () => {
    const sqlite = cellar();
    sqlite.exec(`INSERT INTO storage_locations (id, site_id, name)
      VALUES ('a', 'site', 'A'), ('b', 'site', 'B')`);
    const context = operationContext(sqlite);
    const renames = await Promise.allSettled(
      ["a", "b"].map(async (storageLocationId) =>
        updateStorageLocation({
          context,
          storageLocationId,
          input: { name: "Destination" },
        }),
      ),
    );
    assert.equal(renames.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = renames.find((result) => result.status === "rejected");
    assert.ok(rejected?.status === "rejected" && rejectionStatus(409)(rejected.reason));
    assert.equal(
      sqlite
        .prepare("SELECT count(*) AS count FROM storage_locations WHERE name = 'Destination'")
        .get()?.["count"],
      1,
    );
    sqlite.close();
  });

  await it("preserves a concurrently created child when deleting its parent", async () => {
    const sqlite = cellar();
    sqlite.exec(
      "INSERT INTO storage_locations (id, site_id, name) VALUES ('parent', 'site', 'Parent')",
    );
    const context = operationContext(sqlite);
    const [deletion, creation] = await Promise.allSettled([
      deleteStorageLocation({ context, storageLocationId: "parent" }),
      createStorageLocation({
        context,
        input: { siteId: "site", parentId: "parent", name: "Child" },
      }),
    ]);
    assert.equal(deletion.status, "fulfilled");
    if (creation.status === "fulfilled") {
      assert.equal(count(sqlite, "storage_locations"), 1);
      assert.equal(
        sqlite
          .prepare("SELECT parent_id FROM storage_locations WHERE id = ?")
          .get(creation.value.after.id)?.["parent_id"],
        null,
      );
    } else {
      assert.ok(rejectionStatus(400)(creation.reason));
      assert.equal(count(sqlite, "storage_locations"), 0);
    }
    assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
    sqlite.close();
  });

  await it("rechecks permission after the pre-read before writing a location or an audit", async () => {
    const sqlite = cellar();
    sqlite.exec(
      "INSERT INTO storage_locations (id, site_id, name) VALUES ('rack', 'site', 'Rack')",
    );
    const before = locations(sqlite);
    const context = operationContext(sqlite, () => {
      sqlite.exec("DELETE FROM site_memberships WHERE site_id = 'site' AND user_id = 'owner'");
    });
    await assert.rejects(
      updateStorageLocation({
        context,
        storageLocationId: "rack",
        input: { name: "Changed" },
      }),
      rejectionStatus(404),
    );
    assert.deepEqual(locations(sqlite), before);
    assert.equal(count(sqlite, "mcp_tool_audit_events"), 0);
    sqlite.close();
  });

  await it("chains actual before/after snapshots and leaves no-op timestamps unchanged", async () => {
    const sqlite = cellar();
    sqlite.exec(
      "INSERT INTO storage_locations (id, site_id, name, updated_at) VALUES ('rack', 'site', 'Rack', 'original')",
    );
    const context = operationContext(sqlite);
    const unchanged = await updateStorageLocation({
      context,
      storageLocationId: "rack",
      input: { name: "Rack" },
    });
    assert.equal(unchanged.affectedRecordCount, 0);
    assert.equal(
      sqlite.prepare("SELECT updated_at FROM storage_locations WHERE id = 'rack'").get()?.[
        "updated_at"
      ],
      "original",
    );
    const changes = await Promise.all([
      updateStorageLocation({ context, storageLocationId: "rack", input: { notes: "first" } }),
      updateStorageLocation({ context, storageLocationId: "rack", input: { notes: "second" } }),
    ]);
    assert.deepEqual(changes[1]?.before, changes[0]?.after);
    const events = sqlite
      .prepare(
        "SELECT before_json, after_json, affected_record_count, input_json, tool_name FROM mcp_tool_audit_events ORDER BY rowid",
      )
      .all();
    assert.equal(events[0]?.["affected_record_count"], 0);
    assert.equal(events[1]?.["after_json"], events[2]?.["before_json"]);
    assert.equal(events[0]?.["tool_name"], "http.cellar.update_storage_location");
    assert.ok(String(events[0]?.["input_json"]).includes('"source":"http"'));
    sqlite.close();
  });

  await it("rolls back location changes when audit insertion or finalization fails", async () => {
    for (const auditWrite of ["INSERT", "UPDATE"]) {
      const sqlite = cellar();
      sqlite.exec(
        "INSERT INTO storage_locations (id, site_id, name) VALUES ('rack', 'site', 'Rack')",
      );
      sqlite.exec(`CREATE TRIGGER reject_audit BEFORE ${auditWrite} ON mcp_tool_audit_events
        BEGIN SELECT RAISE(ABORT, 'simulated audit failure'); END`);
      const before = locations(sqlite);
      await assert.rejects(
        updateStorageLocation({
          context: operationContext(sqlite),
          storageLocationId: "rack",
          input: { name: "Changed" },
        }),
        /simulated audit failure/u,
      );
      assert.deepEqual(locations(sqlite), before);
      assert.equal(count(sqlite, "mcp_tool_audit_events"), 0);
      sqlite.close();
    }
  });

  await it("audits every detached child, capture and bottle link when deleting a location", async () => {
    const sqlite = cellar();
    sqlite.exec(`
      INSERT INTO storage_locations (id, site_id, name) VALUES ('rack', 'site', 'Rack');
      INSERT INTO storage_locations (id, site_id, parent_id, name) VALUES ('child', 'site', 'rack', 'Child');
      INSERT INTO wine_vintages (id, site_id, base_name, display_name, vintage_label) VALUES ('wine', 'site', 'Wine', 'Wine', 'NV');
      INSERT INTO bottles (id, site_id, wine_vintage_id) VALUES ('bottle', 'site', 'wine');
      INSERT INTO bottle_locations (bottle_id, site_id, storage_location_id, position_hint) VALUES ('bottle', 'site', 'rack', 'A1');
      INSERT INTO bottle_captures (id, site_id, user_id, storage_location_id, position_hint, status)
        VALUES ('capture', 'site', 'owner', 'rack', 'A2', 'needs_review');
    `);
    sqlite.exec(`CREATE TRIGGER reject_audit BEFORE UPDATE ON mcp_tool_audit_events
      BEGIN SELECT RAISE(ABORT, 'simulated audit failure'); END`);
    await assert.rejects(
      deleteStorageLocation({
        context: operationContext(sqlite),
        storageLocationId: "rack",
      }),
      /simulated audit failure/u,
    );
    assert.equal(
      sqlite
        .prepare("SELECT storage_location_id FROM bottle_locations WHERE bottle_id = 'bottle'")
        .get()?.["storage_location_id"],
      "rack",
    );
    assert.equal(
      sqlite
        .prepare("SELECT storage_location_id FROM bottle_captures WHERE id = 'capture'")
        .get()?.["storage_location_id"],
      "rack",
    );
    assert.equal(
      sqlite.prepare("SELECT parent_id FROM storage_locations WHERE id = 'child'").get()?.[
        "parent_id"
      ],
      "rack",
    );
    assert.equal(count(sqlite, "mcp_tool_audit_events"), 0);
    sqlite.exec("DROP TRIGGER reject_audit");
    const result = await deleteStorageLocation({
      context: operationContext(sqlite),
      storageLocationId: "rack",
    });
    assert.equal(result.before.location?.id, "rack");
    assert.deepEqual(result.after, {
      location: null,
      bottleLocations: [],
      captures: [{ id: "capture", storageLocationId: null, positionHint: null }],
      children: [{ id: "child", parentId: null }],
    });
    assert.equal(result.affectedRecordCount, 4);
    assert.equal(count(sqlite, "bottles"), 1);
    assert.equal(count(sqlite, "bottle_captures"), 1);
    assert.equal(count(sqlite, "storage_locations"), 1);
    assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
    sqlite.close();
  });
});
