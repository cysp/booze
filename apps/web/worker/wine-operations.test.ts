import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { createD1Client } from "@chikachow/booze-db";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";

import { asD1, migratedDatabase } from "./d1-support.ts";
import type { OperationContext } from "./operation-transaction.ts";
import { setDrinkingWindow } from "./wine-operations.ts";

function cellar(): DatabaseSync {
  const sqlite = migratedDatabase();
  sqlite.exec(`
    INSERT INTO users (id, clerk_user_id) VALUES ('owner', 'owner');
    INSERT INTO sites (id, name) VALUES ('site', 'Cellar');
    INSERT INTO site_memberships (site_id, user_id, role) VALUES ('site', 'owner', 'owner');
    INSERT INTO wine_vintages (id, site_id, base_name, display_name, vintage_label, updated_at)
      VALUES ('wine', 'site', 'Wine', 'Wine', 'NV', 'original');
    INSERT INTO bottles (id, site_id, wine_vintage_id, status)
      VALUES ('available', 'site', 'wine', 'in_stock'), ('consumed', 'site', 'wine', 'consumed');
  `);
  return sqlite;
}

function operationContext(
  sqlite: DatabaseSync,
  hooks: {
    readonly beforeBatch?: () => void;
    readonly afterBatch?: () => void;
  } = {},
): OperationContext {
  const d1 = asD1(sqlite);
  const batch = d1.batch.bind(d1);
  return {
    database: createD1Client(
      Object.assign(d1, {
        async batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
          hooks.beforeBatch?.();
          const result = await batch<T>(statements);
          hooks.afterBatch?.();
          return result;
        },
      }),
    ),
    userId: "owner",
    source: "mcp",
  };
}

function wine(sqlite: DatabaseSync): Record<string, unknown> {
  return { ...sqlite.prepare("SELECT * FROM wine_vintages WHERE id = 'wine'").get() };
}

function auditCount(sqlite: DatabaseSync): number {
  return Number(
    sqlite.prepare("SELECT count(*) AS count FROM mcp_tool_audit_events").get()?.["count"],
  );
}

await describe("drinking-window operations", async () => {
  await it("commits parallel changes with an actual before/after audit chain", async () => {
    const sqlite = cellar();
    const context = operationContext(sqlite);
    const results = await Promise.all([
      setDrinkingWindow({ context, wineVintageId: "wine", drinkFromYear: 2025, drinkToYear: 2030 }),
      setDrinkingWindow({ context, wineVintageId: "wine", drinkFromYear: 2027, drinkToYear: 2035 }),
    ]);
    assert.deepEqual(results[0]?.before, {
      id: "wine",
      siteId: "site",
      drinkFromYear: null,
      drinkToYear: null,
      bottleCount: 2,
    });
    assert.deepEqual(results[1]?.before, results[0]?.after);
    assert.equal(results[0]?.affectedBottleCount, 2);
    assert.equal(results[1]?.affectedBottleCount, 2);
    const events = sqlite
      .prepare(
        "SELECT before_json, after_json, affected_record_count, tool_name FROM mcp_tool_audit_events ORDER BY rowid",
      )
      .all();
    assert.equal(events[0]?.["after_json"], events[1]?.["before_json"]);
    assert.equal(events[0]?.["affected_record_count"], 1);
    assert.equal(events[1]?.["affected_record_count"], 1);
    assert.equal(events[0]?.["tool_name"], "cellar.set_drinking_window");
    sqlite.close();
  });

  await it("records a successful no-op with zero affected records and leaves timestamps unchanged", async () => {
    const sqlite = cellar();
    const before = wine(sqlite);
    const result = await setDrinkingWindow({
      context: operationContext(sqlite),
      wineVintageId: "wine",
      drinkFromYear: null,
      drinkToYear: null,
    });
    assert.deepEqual(result.before, result.after);
    assert.equal(result.changed, false);
    assert.equal(result.affectedRecordCount, 0);
    assert.equal(result.affectedBottleCount, 2);
    assert.deepEqual(wine(sqlite), before);
    assert.equal(auditCount(sqlite), 1);
    sqlite.close();
  });

  await it("rejects invalid years and reversed windows without any wine or audit changes", async () => {
    const sqlite = cellar();
    const before = wine(sqlite);
    const context = operationContext(sqlite);
    for (const [drinkFromYear, drinkToYear] of [
      [1799, 2030],
      [2025, 2201],
      [2025.5, 2030],
      [2030, 2025],
    ]) {
      assert.ok(drinkFromYear !== undefined && drinkToYear !== undefined);
      await assert.rejects(
        setDrinkingWindow({ context, wineVintageId: "wine", drinkFromYear, drinkToYear }),
        ZodError,
      );
    }
    assert.deepEqual(wine(sqlite), before);
    assert.equal(auditCount(sqlite), 0);
    sqlite.close();
  });

  await it("counts bottles and snapshots the current window inside the committing batch", async () => {
    const sqlite = cellar();
    const context = operationContext(sqlite, {
      beforeBatch() {
        sqlite.exec(`
        UPDATE wine_vintages SET drink_from_year = 2020, drink_to_year = 2024 WHERE id = 'wine';
        INSERT INTO bottles (id, site_id, wine_vintage_id) VALUES ('new', 'site', 'wine');
      `);
      },
    });
    const result = await setDrinkingWindow({
      context,
      wineVintageId: "wine",
      drinkFromYear: 2025,
      drinkToYear: 2030,
    });
    assert.equal(result.before.drinkFromYear, 2020);
    assert.equal(result.before.drinkToYear, 2024);
    assert.equal(result.before.bottleCount, 3);
    assert.equal(result.after.bottleCount, 3);
    assert.equal(result.affectedBottleCount, 3);
    sqlite.close();
  });

  await it("returns the committed operation facts even if another change follows immediately", async () => {
    const sqlite = cellar();
    const context = operationContext(sqlite, {
      afterBatch() {
        sqlite.exec(
          "UPDATE wine_vintages SET drink_from_year = 2040, drink_to_year = 2050 WHERE id = 'wine'",
        );
      },
    });
    const result = await setDrinkingWindow({
      context,
      wineVintageId: "wine",
      drinkFromYear: 2025,
      drinkToYear: 2030,
    });
    assert.equal(result.after.drinkFromYear, 2025);
    assert.equal(result.after.drinkToYear, 2030);
    assert.equal(wine(sqlite)["drink_from_year"], 2040);
    assert.equal(wine(sqlite)["drink_to_year"], 2050);
    sqlite.close();
  });

  await it("rechecks membership inside the batch before any wine or success-audit write", async () => {
    const sqlite = cellar();
    const before = wine(sqlite);
    const context = operationContext(sqlite, {
      beforeBatch() {
        sqlite.exec(
          "UPDATE site_memberships SET role = 'viewer' WHERE site_id = 'site' AND user_id = 'owner'",
        );
      },
    });
    await assert.rejects(
      setDrinkingWindow({ context, wineVintageId: "wine", drinkFromYear: 2025, drinkToYear: 2030 }),
      (error: unknown) => error instanceof HTTPException && error.status === 403,
    );
    assert.deepEqual(wine(sqlite), before);
    assert.equal(auditCount(sqlite), 0);
    sqlite.close();
  });

  await it("does not claim success when the wine disappears after the permission pre-read", async () => {
    const sqlite = cellar();
    const context = operationContext(sqlite, {
      beforeBatch() {
        sqlite.exec(
          "DELETE FROM bottles WHERE wine_vintage_id = 'wine'; DELETE FROM wine_vintages WHERE id = 'wine'",
        );
      },
    });
    await assert.rejects(
      setDrinkingWindow({ context, wineVintageId: "wine", drinkFromYear: 2025, drinkToYear: 2030 }),
      (error: unknown) => error instanceof HTTPException && error.status === 404,
    );
    assert.equal(auditCount(sqlite), 0);
    sqlite.close();
  });

  await it("rolls back the real operation if audit insertion or finalization fails", async () => {
    for (const auditWrite of ["INSERT", "UPDATE"]) {
      const sqlite = cellar();
      sqlite.exec(`CREATE TRIGGER reject_audit BEFORE ${auditWrite} ON mcp_tool_audit_events
        BEGIN SELECT RAISE(ABORT, 'simulated audit failure'); END`);
      const before = wine(sqlite);
      await assert.rejects(
        setDrinkingWindow({
          context: operationContext(sqlite),
          wineVintageId: "wine",
          drinkFromYear: 2025,
          drinkToYear: 2030,
        }),
        /simulated audit failure/u,
      );
      assert.deepEqual(wine(sqlite), before);
      assert.equal(auditCount(sqlite), 0);
      sqlite.close();
    }
  });
});
