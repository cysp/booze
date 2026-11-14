import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createD1Client } from "@chikachow/booze-db";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import { asD1, migratedDatabase } from "./d1-support.ts";
import {
  addBottles,
  consumeBottle,
  createBottleSchema,
  deleteBottle,
  editBottle,
  moveBottle,
  restoreBottle,
} from "./catalogue-operations.ts";
import { deleteStorageLocation } from "./location-operations.ts";
import type { OperationContext } from "./operation-transaction.ts";

function setup() {
  const sqlite = migratedDatabase();
  sqlite.exec(`INSERT INTO users(id,clerk_user_id) VALUES ('user','clerk');
    INSERT INTO sites(id,name) VALUES ('site','Cellar');
    INSERT INTO site_memberships(site_id,user_id,role,created_at,updated_at) VALUES ('site','user','owner','original-created','original-updated');
    INSERT INTO storage_locations(id,site_id,name) VALUES ('one','site','First'),('two','site','Second');
    INSERT INTO wine_vintages(id,site_id,base_name,display_name,vintage_label,notes) VALUES ('wine','site','Reserve','Reserve','Unknown','Original wine');
    INSERT INTO bottles(id,site_id,wine_vintage_id,notes) VALUES ('bottle','site','wine','Original bottle');
    INSERT INTO bottle_locations(bottle_id,site_id,storage_location_id,position_hint) VALUES ('bottle','site','one','A1');
    INSERT INTO label_extractions(id,bottle_id,wine_vintage_id,extracted_fields_json,raw_text_json) VALUES ('evidence','bottle','wine','{"secret":"original evidence"}','raw original evidence');`);
  const d1 = asD1(sqlite);
  const context: OperationContext = {
    database: createD1Client(d1),
    userId: "user",
    source: "http",
  };
  const interleave = (action: () => void | Promise<void>) => {
    const batch = d1.batch.bind(d1);
    let pending = true;
    d1.batch = async (statements) => {
      if (pending) {
        pending = false;
        await action();
      }
      return batch(statements);
    };
  };
  const independentContext: OperationContext = {
    ...context,
    database: createD1Client(asD1(sqlite)),
    source: "mcp",
  };
  return { sqlite, d1, context, independentContext, interleave };
}

function statusError(status: number) {
  return (error: unknown) => error instanceof HTTPException && error.status === status;
}

function audits(sqlite: ReturnType<typeof migratedDatabase>) {
  return sqlite
    .prepare(
      "SELECT before_json, after_json, affected_record_count, tool_name, input_json FROM mcp_tool_audit_events ORDER BY rowid",
    )
    .all()
    .map((row) => ({
      before: z.record(z.string(), z.unknown()).parse(JSON.parse(String(row["before_json"]))),
      after: z.record(z.string(), z.unknown()).parse(JSON.parse(String(row["after_json"]))),
      count: row["affected_record_count"],
      toolName: row["tool_name"],
      input: String(row["input_json"]),
    }));
}

await describe("complete bottle operations", async () => {
  await it("rejects invalid direct addition and edit inputs before changing stock or audit", async () => {
    const invalidAdditions: readonly Partial<z.infer<typeof createBottleSchema>>[] = [
      ...[0, 25, 1.5, Infinity].map((quantity) => ({ quantity })),
      ...[0, 30_001, 750.5, Number.NaN].map((volumeMl) => ({ bottle: { volumeMl } })),
      { wine: { wineryName: "Producer", designation: "New wine", alcoholPercent: 101 } },
      {
        wine: {
          wineryName: "Producer",
          designation: "New wine",
          vintageYear: 2020,
          vintageStatus: "unknown",
        },
      },
      {
        wine: {
          wineryName: "Producer",
          designation: "New wine",
          drinkFromYear: 2030,
          drinkToYear: 2020,
        },
      },
    ];
    for (const invalid of invalidAdditions) {
      const { sqlite, context } = setup();
      try {
        await assert.rejects(
          addBottles(context, {
            operationId: crypto.randomUUID(),
            siteId: "site",
            quantity: 1,
            wine: { wineryName: "Producer", designation: "New wine" },
            bottle: {},
            ...invalid,
          }),
        );
        assert.equal(sqlite.prepare("SELECT count(*) AS count FROM bottles").get()?.["count"], 1);
        assert.equal(
          sqlite.prepare("SELECT count(*) AS count FROM wine_vintages").get()?.["count"],
          1,
        );
        assert.equal(audits(sqlite).length, 0);
        await assert.rejects(editBottle(context, "bottle", { bottle: { volumeMl: 0 } }));
        assert.equal(sqlite.prepare("SELECT volume_ml FROM bottles").get()?.["volume_ml"], 750);
        assert.equal(audits(sqlite).length, 0);
      } finally {
        sqlite.close();
      }
    }
  });

  await it("clears nullable wine facts explicitly and preserves omitted facts in shared corrections", async () => {
    const { sqlite, context } = setup();
    try {
      sqlite.exec(
        "UPDATE wine_vintages SET vintage_year = 2020, vintage_status = 'year', vintage_label = '2020', alcohol_percent = 14.5, drink_from_year = 2025, drink_to_year = 2035, region = 'Original region'",
      );
      await editBottle(context, "bottle", {
        wineEditScope: "shared",
        expectedWineVintageId: "wine",
        expectedAffectedBottleCount: 1,
        wine: {
          vintageYear: null,
          vintageStatus: "unknown",
          alcoholPercent: null,
          drinkFromYear: null,
          drinkToYear: null,
          notes: null,
        },
      });
      assert.deepEqual(
        {
          ...sqlite
            .prepare(
              "SELECT vintage_year, vintage_status, alcohol_percent, drink_from_year, drink_to_year, notes, region FROM wine_vintages",
            )
            .get(),
        },
        {
          vintage_year: null,
          vintage_status: "unknown",
          alcohol_percent: null,
          drink_from_year: null,
          drink_to_year: null,
          notes: null,
          region: "Original region",
        },
      );
      await assert.rejects(
        editBottle(context, "bottle", {
          wineEditScope: "shared",
          expectedWineVintageId: "wine",
          expectedAffectedBottleCount: 1,
          wine: { drinkFromYear: 2030 },
        }),
      );
      assert.equal(audits(sqlite).length, 1);
    } finally {
      sqlite.close();
    }
  });

  await it("rejects a move when consumption commits after preparation and before its transaction", async () => {
    const { sqlite, context, independentContext, interleave } = setup();
    interleave(async () => {
      await consumeBottle(independentContext, "bottle");
    });
    await assert.rejects(
      moveBottle(context, "bottle", { storageLocationId: "two", positionHint: "B2" }),
      statusError(400),
    );
    assert.deepEqual(
      { ...sqlite.prepare("SELECT status, notes FROM bottles").get() },
      { status: "consumed", notes: "Original bottle" },
    );
    assert.equal(
      sqlite.prepare("SELECT storage_location_id FROM bottle_locations").get()?.[
        "storage_location_id"
      ],
      "one",
    );
    assert.equal(audits(sqlite).length, 1);
  });

  await it("chains actual committed movement, consumption, and successful no-op snapshots", async () => {
    const { sqlite, context, independentContext, interleave } = setup();
    interleave(async () => {
      await moveBottle(independentContext, "bottle", {
        storageLocationId: "two",
        positionHint: "B2",
      });
    });
    const consumed = await consumeBottle(context, "bottle");
    assert.equal(consumed.before.storageLocationId, "two");
    assert.equal(consumed.after?.positionHint, "B2");
    assert.equal(consumed.after?.status, "consumed");
    const noop = await consumeBottle(context, "bottle");
    assert.equal(noop.changed, false);
    assert.equal(noop.affectedRecordCount, 0);
    const events = audits(sqlite);
    assert.deepEqual(events[0]?.after, events[1]?.before);
    assert.deepEqual(events[1]?.after, events[2]?.before);
    assert.deepEqual(events[2]?.before, events[2]?.after);
    assert.equal(events[0]?.toolName, "cellar.set_bottle_location");
    assert.equal(events[1]?.toolName, "http.cellar.mark_bottle_consumed");
    assert.ok(events.every((event) => !JSON.stringify(event).includes("original evidence")));
    assert.deepEqual(
      Object.keys(consumed.before).toSorted(),
      [
        "bottleId",
        "positionHint",
        "siteId",
        "status",
        "storageLocationId",
        "wineVintageId",
      ].toSorted(),
    );
  });

  await it("rejects location clearing and position-only changes on consumed history without changing metadata", async () => {
    const { sqlite, context } = setup();
    await consumeBottle(context, "bottle");
    for (const patch of [{ storageLocationId: null }, { positionHint: "Changed" }]) {
      await assert.rejects(
        editBottle(context, "bottle", { ...patch, bottle: { notes: "Must not save" } }),
        statusError(400),
      );
    }
    assert.equal(sqlite.prepare("SELECT notes FROM bottles").get()?.["notes"], "Original bottle");
    assert.equal(
      sqlite.prepare("SELECT position_hint FROM bottle_locations").get()?.["position_hint"],
      "A1",
    );
    assert.equal(audits(sqlite).length, 1);
  });

  await it("preserves a same-location position, resets a new-location position, and audits a no-op", async () => {
    const { sqlite, context } = setup();
    const same = await moveBottle(context, "bottle", { storageLocationId: "one" });
    assert.equal(same.changed, false);
    assert.equal(same.after?.positionHint, "A1");
    const moved = await moveBottle(context, "bottle", { storageLocationId: "two" });
    assert.equal(moved.after?.positionHint, null);
    assert.equal(moved.changed, true);
    const cleared = await moveBottle(context, "bottle", { storageLocationId: null });
    assert.equal(cleared.after?.storageLocationId, null);
    assert.equal(cleared.after?.positionHint, null);
    assert.deepEqual(
      audits(sqlite).map((event) => event.count),
      [0, 1, 1],
    );
  });

  await it("allows bottle and shared wine metadata corrections on consumed history", async () => {
    const { sqlite, context } = setup();
    await consumeBottle(context, "bottle");
    const changed = await editBottle(context, "bottle", {
      bottle: { notes: "Corrected bottle" },
      wine: { notes: "Corrected wine" },
      wineEditScope: "shared",
      expectedWineVintageId: "wine",
      expectedAffectedBottleCount: 1,
    });
    assert.equal(changed.after?.status, "consumed");
    assert.equal(changed.before.bottle?.["notes"], "Original bottle");
    assert.equal(changed.after?.bottle?.["notes"], "Corrected bottle");
    assert.equal(changed.after?.wine?.["notes"], "Corrected wine");
    assert.equal(changed.after?.wineBottleCount, 1);
    assert.equal(sqlite.prepare("SELECT status FROM bottles").get()?.["status"], "consumed");
  });

  await it("restores history with its surviving location and leaves deleted locations unset", async () => {
    const { context } = setup();
    await consumeBottle(context, "bottle");
    assert.equal((await restoreBottle(context, "bottle")).after?.storageLocationId, "one");
    await consumeBottle(context, "bottle");
    await deleteStorageLocation({ context, storageLocationId: "one" });
    const restored = await restoreBottle(context, "bottle");
    assert.equal(restored.after?.status, "in_stock");
    assert.equal(restored.after?.storageLocationId, null);
    assert.equal(restored.after?.positionHint, null);
  });

  for (const revoke of [
    "UPDATE site_memberships SET role = 'viewer'",
    "DELETE FROM site_memberships",
  ]) {
    await it(`rolls back every bottle write and audit after permission revocation: ${revoke}`, async () => {
      const { sqlite, context, interleave } = setup();
      interleave(() => {
        sqlite.exec(revoke);
      });
      await assert.rejects(
        moveBottle(context, "bottle", { storageLocationId: "two" }),
        statusError(revoke.startsWith("UPDATE") ? 403 : 404),
      );
      assert.equal(
        sqlite.prepare("SELECT storage_location_id FROM bottle_locations").get()?.[
          "storage_location_id"
        ],
        "one",
      );
      assert.equal(audits(sqlite).length, 0);
    });
  }

  await it("does not modify an allowed membership while guarding its transaction", async () => {
    const { sqlite, context } = setup();
    const before = sqlite.prepare("SELECT * FROM site_memberships").get();
    await moveBottle(context, "bottle", { storageLocationId: "two" });
    assert.deepEqual(sqlite.prepare("SELECT * FROM site_memberships").get(), before);
  });

  await it("rejects a shared correction when its wine assignment changes before commit", async () => {
    const { sqlite, context, interleave } = setup();
    interleave(() => {
      sqlite.exec(`INSERT INTO wine_vintages(id,site_id,base_name,display_name,vintage_label) VALUES ('other','site','Other','Other','Unknown');
      UPDATE bottles SET wine_vintage_id = 'other'`);
    });
    await assert.rejects(
      editBottle(context, "bottle", {
        wine: { notes: "Must not save" },
        bottle: { notes: "Must not save" },
        wineEditScope: "shared",
        expectedWineVintageId: "wine",
        expectedAffectedBottleCount: 1,
      }),
      statusError(409),
    );
    assert.equal(
      sqlite.prepare("SELECT notes FROM wine_vintages WHERE id='wine'").get()?.["notes"],
      "Original wine",
    );
    assert.equal(sqlite.prepare("SELECT notes FROM bottles").get()?.["notes"], "Original bottle");
    assert.equal(audits(sqlite).length, 0);
  });

  for (const timing of ["INSERT", "UPDATE"]) {
    await it(`rolls the complete mutation back when audit ${timing.toLowerCase()} fails`, async () => {
      const { sqlite, context } = setup();
      sqlite.exec(
        `CREATE TRIGGER fail_audit BEFORE ${timing} ON mcp_tool_audit_events BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`,
      );
      await assert.rejects(
        editBottle(context, "bottle", {
          bottle: { notes: "Must not save" },
          storageLocationId: "two",
        }),
        /audit unavailable/u,
      );
      assert.equal(sqlite.prepare("SELECT notes FROM bottles").get()?.["notes"], "Original bottle");
      assert.equal(
        sqlite.prepare("SELECT storage_location_id FROM bottle_locations").get()?.[
          "storage_location_id"
        ],
        "one",
      );
      assert.equal(audits(sqlite).length, 0);
    });
  }

  await it("resolves an addition's lost acknowledgement once, with one receipt and one audit", async () => {
    const { sqlite, context, d1 } = setup();
    const batch = d1.batch.bind(d1);
    let loseAcknowledgement = true;
    d1.batch = async <T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
      const result = await batch<T>(statements);
      if (loseAcknowledgement) {
        loseAcknowledgement = false;
        throw new Error("committed acknowledgement lost");
      }
      return result;
    };
    const input = createBottleSchema.parse({
      operationId: crypto.randomUUID(),
      siteId: "site",
      wineVintageId: "wine",
      quantity: 2,
    });
    const first = await addBottles(context, input);
    assert.deepEqual(await addBottles(context, input), first);
    assert.equal(sqlite.prepare("SELECT count(*) n FROM bottles").get()?.["n"], 3);
    assert.equal(sqlite.prepare("SELECT count(*) n FROM addition_receipts").get()?.["n"], 1);
    assert.deepEqual(
      audits(sqlite).map((event) => event.count),
      [2],
    );
  });

  await it("deletes one bottle and its evidence atomically while retaining shared wine facts", async () => {
    const { sqlite, context } = setup();
    const deleted = await deleteBottle(context, "bottle");
    assert.equal(deleted.before.bottleId, "bottle");
    assert.equal(deleted.after, null);
    for (const table of ["bottles", "bottle_locations", "label_extractions"])
      assert.equal(sqlite.prepare(`SELECT count(*) n FROM ${table}`).get()?.["n"], 0);
    assert.equal(
      sqlite.prepare("SELECT notes FROM wine_vintages").get()?.["notes"],
      "Original wine",
    );
    assert.equal(audits(sqlite).length, 1);
  });
});
