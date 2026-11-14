import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { env } from "node:process";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { fileURLToPath, URL } from "node:url";
import { z } from "zod";

// oxlint-disable-next-line import/max-dependencies -- This integration test coordinates Node fixtures, Wrangler, and schema validation.
import { schemaQueries } from "../../../packages/db/src/schema-test-support.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const migrationPath = "packages/db/migrations/";
const cli = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));

function git(...args: readonly string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

type MigrationFiles = Readonly<Record<string, string>>;

function localD1(config: string, state: string, args: readonly string[]) {
  const result = spawnSync(
    "node",
    [cli, "d1", ...args, "--local", "--persist-to", state, "--config", config],
    {
      cwd: path.dirname(config),
      encoding: "utf8",
      timeout: 60_000,
      env: { ...env, CI: "true", WRANGLER_SEND_METRICS: "false", WRANGLER_WRITE_LOGS: "false" },
    },
  );
  assert.equal(
    result.status,
    0,
    `${config}: ${result.error ?? ""}\n${result.stdout}\n${result.stderr}`,
  );
  return result.stdout;
}

function preserveHistory(base: MigrationFiles, candidate: MigrationFiles) {
  for (const [name, sql] of Object.entries(base)) {
    assert.equal(
      candidate[name],
      sql,
      `Previously accepted migration changed or disappeared: ${name}`,
    );
  }
}

// Use Wrangler itself: its pending-file ordering, ledger, and D1 transactions
// are independent of Drizzle's snapshot checker and node:sqlite's defaults.
function verifyUpgrade(
  base: MigrationFiles,
  candidate: MigrationFiles,
  {
    seed = "",
    retainedRows = "",
    expectedFailure,
    afterUpgradeChecks = [],
  }: {
    readonly seed?: string;
    readonly retainedRows?: string;
    readonly expectedFailure?: RegExp;
    readonly afterUpgradeChecks?: readonly {
      sql: string;
      expected: readonly (readonly Record<string, string | number | null>[])[];
    }[];
  } = {},
) {
  preserveHistory(base, candidate);
  const directory = mkdtempSync(path.join(tmpdir(), "booze-d1-upgrade-"));
  const database = "migration-test";
  try {
    for (const [layout, files] of Object.entries({ base, candidate })) {
      const folder = path.join(directory, layout);
      mkdirSync(folder);
      for (const [name, sql] of Object.entries(files)) {
        const filename = path.join(folder, "migrations", name);
        mkdirSync(path.dirname(filename), { recursive: true });
        writeFileSync(filename, sql);
      }
      writeFileSync(
        path.join(folder, "wrangler.json"),
        JSON.stringify({
          name: database,
          compatibility_date: "2026-09-22",
          d1_databases: [
            {
              binding: "DB",
              database_name: database,
              database_id: "00000000-0000-0000-0000-000000000001",
              migrations_dir: "migrations",
              migrations_pattern: "migrations/**/*.sql",
            },
          ],
        }),
      );
    }
    const run = (layout: string, state: string, args: readonly string[]) =>
      localD1(path.join(directory, layout, "wrangler.json"), path.join(directory, state), args);
    const query = (layout: string, state: string, sql: string) => {
      return z
        .array(
          z.object({
            results: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.null()]))),
          }),
        )
        .parse(JSON.parse(run(layout, state, ["execute", database, "--command", sql, "--json"])))
        .map((statement) => statement.results);
    };
    const apply = (layout: string, state: string) =>
      run(layout, state, ["migrations", "apply", database]);
    const ledger = "SELECT id, name, applied_at FROM d1_migrations ORDER BY id";
    apply("base", "existing");
    if (seed !== "") query("base", "existing", seed);
    const [beforeLedger = []] = query("base", "existing", ledger);
    assert.equal(beforeLedger.length, Object.keys(base).length);
    const beforeRows = retainedRows === "" ? [] : query("base", "existing", retainedRows);
    if (expectedFailure !== undefined) {
      const schema = "SELECT type, name, sql FROM sqlite_schema ORDER BY type, name";
      const beforeSchema = query("base", "existing", schema);
      assert.throws(() => {
        apply("candidate", "existing");
      }, expectedFailure);
      assert.deepEqual(query("candidate", "existing", ledger), [beforeLedger]);
      assert.deepEqual(query("candidate", "existing", schema), beforeSchema);
      if (retainedRows !== "") {
        assert.deepEqual(query("candidate", "existing", retainedRows), beforeRows);
      }
      assert.deepEqual(query("candidate", "existing", "PRAGMA foreign_key_check"), [[]]);
      return;
    }
    apply("candidate", "existing");
    for (const check of afterUpgradeChecks)
      assert.deepEqual(query("candidate", "existing", check.sql), check.expected);
    const [afterLedger = []] = query("candidate", "existing", ledger);
    assert.deepEqual(afterLedger.slice(0, beforeLedger.length), beforeLedger);
    assert.deepEqual(
      afterLedger.map((row) => z.string().parse(row["name"])).toSorted(),
      Object.keys(candidate).toSorted(),
    );
    if (retainedRows !== "")
      assert.deepEqual(query("candidate", "existing", retainedRows), beforeRows);
    assert.deepEqual(query("candidate", "existing", "PRAGMA foreign_key_check"), [[]]);
    assert.match(apply("candidate", "existing"), /No migrations to apply/u);

    apply("candidate", "fresh");
    const inspect = (state: string) => {
      // D1 restricts some table-valued PRAGMAs. Parse its actual DDL in SQLite
      // to use the same column-order-insensitive oracle as the export test.
      const [definitions = []] = query(
        "candidate",
        state,
        `SELECT sql FROM sqlite_schema
        WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*'
          AND name != 'd1_migrations'
        ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, name`,
      );
      const parsed = new DatabaseSync(":memory:");
      try {
        for (const { sql } of definitions) {
          assert.equal(typeof sql, "string");
          parsed.exec(z.string().parse(sql));
        }
        return Object.fromEntries(
          Object.entries(schemaQueries).map(([name, sql]) => [name, parsed.prepare(sql).all()]),
        );
      } finally {
        parsed.close();
      }
    };
    assert.deepEqual(
      inspect("existing"),
      inspect("fresh"),
      "Upgrade from the target branch must reach the same schema as a fresh database",
    );
    const [freshLedger = []] = query("candidate", "fresh", ledger);
    assert.deepEqual(
      freshLedger.map((row) => z.string().parse(row["name"])).toSorted(),
      Object.keys(candidate).toSorted(),
    );
    assert.deepEqual(query("candidate", "fresh", "PRAGMA foreign_key_check"), [[]]);
    assert.match(apply("candidate", "fresh"), /No migrations to apply/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

void it("upgrades the accepted target history on populated local D1 without replaying old migrations", () => {
  // CI supplies the PR target SHA or previous main SHA, never the merge base.
  // Local runs use the fetched origin/main; fetch it before validating a PR.
  const ref = env["BOOZE_MIGRATION_BASE"] ?? "origin/main";
  const sha = git("rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`).trim();
  const names = git("ls-tree", "-r", "--name-only", "-z", sha, "--", migrationPath)
    .split("\0")
    .filter((name) => name.endsWith(".sql"));
  assert.ok(names.length > 0, `No migration history at target ${sha}`);
  const base = Object.fromEntries(
    names.map((name) => [name.slice(migrationPath.length), git("show", `${sha}:${name}`)]),
  );
  verifyWineUpgrade(base, readCandidateMigrations());
});

const identityMigration = "20260922034734_wine_identity_and_capture_review/migration.sql";

function readCandidateMigrations(): MigrationFiles {
  const folder = path.join(root, migrationPath);
  return Object.fromEntries(
    readdirSync(folder, { recursive: true, encoding: "utf8" })
      .filter((name) => name.endsWith(".sql"))
      .map((name) => [name, readFileSync(path.join(folder, name), "utf8")]),
  );
}

void it("transforms legacy wine identity on populated local D1 after the migration reaches main", () => {
  const candidate = readCandidateMigrations();
  assert.ok(identityMigration in candidate);
  const base = Object.fromEntries(
    Object.entries(candidate).filter(([name]) => name < identityMigration),
  );
  verifyWineUpgrade(base, candidate);
});

function verifyWineUpgrade(base: MigrationFiles, candidate: MigrationFiles) {
  const identityAlreadyApplied = identityMigration in base;
  verifyUpgrade(base, candidate, {
    seed: `INSERT INTO users (id, clerk_user_id) VALUES ('migration-user', 'migration-clerk');
      INSERT INTO sites (id, name) VALUES ('migration-site', 'Migration fixture');
      INSERT INTO site_memberships (site_id, user_id, role) VALUES ('migration-site', 'migration-user', 'owner');
      INSERT INTO wineries (id, site_id, name) VALUES ('producer', 'migration-site', 'RIKARD');
      INSERT INTO wine_vintages (id, site_id, winery_id, base_name, display_name, vintage_year, vintage_label, notes)
        VALUES ('known', 'migration-site', 'producer', 'Shiraz', 'RIKARD Shiraz', 2022, '2022', 'Keep facts'),
               ('yearless', 'migration-site', 'producer', 'Blend', 'RIKARD Blend', NULL, 'NV', 'Year was not read');
      ${
        identityAlreadyApplied
          ? `UPDATE wine_vintages SET vintage_status = 'year' WHERE id = 'known';
             UPDATE wine_vintages SET vintage_label = 'Unknown' WHERE id = 'yearless';`
          : ""
      }
      INSERT INTO bottles (id, site_id, wine_vintage_id) VALUES ('bottle-known', 'migration-site', 'known'), ('bottle-yearless', 'migration-site', 'yearless');
      INSERT INTO grape_varieties (id, name) VALUES ('shiraz', 'Shiraz');
      INSERT INTO wine_constituents (site_id, wine_vintage_id, grape_variety_id, percentage, blend_text)
        VALUES ('migration-site', 'known', 'shiraz', 100, 'Original blend');
      INSERT INTO storage_locations (id, site_id, name) VALUES ('migration-rack', 'migration-site', 'Legacy rack');
      INSERT INTO image_assets (id, site_id, sha256, r2_key, content_type, size_bytes,
        thumbnail_r2_key, thumbnail_content_type, thumbnail_size_bytes, thumbnail_width, thumbnail_height,
        width, height, uploaded_by_user_id)
        VALUES ('shared-image', 'migration-site', 'legacy-image-digest', 'legacy/original.heic', 'image/heic', 812345,
          'legacy/thumbnail.webp', 'image/webp', 4567, 240, 180, 4032, 3024, 'migration-user');
      INSERT INTO bottle_captures (id, site_id, user_id, storage_location_id, position_hint, quantity,
        status, workflow_instance_id, imported_bottle_ids_json, error_message, error_detail_json)
        VALUES ('legacy-imported', 'migration-site', 'migration-user', 'migration-rack', 'Upper left', 1,
          'imported', 'legacy-workflow', '["bottle-known"]', NULL, NULL),
          ('legacy-review', 'migration-site', 'migration-user', NULL, 'In box', 2,
          'needs_review', 'legacy-review-workflow', NULL, 'Check original label', '{"reason":"uncertain year"}');
      ${identityAlreadyApplied ? `UPDATE bottle_captures SET review_candidate_json = '{"wine":{"wineryName":"RIKARD","designation":"Shiraz","vintageYear":2022},"bottle":{}}', review_revision = 3 WHERE id = 'legacy-review';` : ""}
      INSERT INTO bottle_capture_images (capture_id, image_asset_id, sort_order, original_filename)
        VALUES ('legacy-imported', 'shared-image', 0, 'Front label.HEIC'),
          ('legacy-review', 'shared-image', 0, 'Retained review original.HEIC');
      INSERT INTO bottle_capture_runs (id, capture_id, status, import_candidate_json, match_result_json, import_result_json,
        extractor_version, model, prompt_version, schema_version, attempt_number,
        extraction_r2_key, extraction_content_type, extraction_size_bytes,
        error_detail_r2_key, error_detail_content_type, error_detail_size_bytes, completed_at)
        VALUES ('legacy-import-run', 'legacy-imported', 'imported', '{"wine":{"wineryName":"RIKARD"},"bottle":{}}',
          '{"wineVintageCandidates":[{"id":"known"}]}', '{"bottleIds":["bottle-known"],"wineVintageId":"known"}',
          'legacy-extractor', 'legacy-model', 'legacy-prompt', 'legacy-schema', 2,
          'legacy/extraction.json', 'application/json', 2345, NULL, NULL, NULL, '2026-09-01T00:00:00Z'),
          ('legacy-review-run', 'legacy-review', 'needs_review', '{"wine":{"wineryName":"RIKARD"},"bottle":{}}', NULL, NULL,
          'legacy-extractor', 'legacy-model', 'legacy-prompt', 'legacy-schema', 1,
          'legacy/review-extraction.json', 'application/json', 3456,
          'legacy/review-error.json', 'application/json', 678, '2026-09-02T00:00:00Z');
      INSERT INTO label_extractions (id, bottle_id, wine_vintage_id, capture_id, capture_run_id, extracted_fields_json)
        VALUES ('evidence', 'bottle-known', 'known', 'legacy-imported', 'legacy-import-run', '{"label":"RIKARD 2022 SHIRAZ"}');`,
    retainedRows: `SELECT id, clerk_user_id FROM users ORDER BY id;
      SELECT id, name FROM sites ORDER BY id;
      SELECT site_id, user_id, role FROM site_memberships ORDER BY site_id, user_id;
      SELECT id, site_id, winery_id, base_name, display_name, vintage_year, notes FROM wine_vintages ORDER BY id;
      SELECT * FROM bottles ORDER BY id;
      SELECT * FROM wine_constituents ORDER BY wine_vintage_id;
      SELECT * FROM label_extractions ORDER BY id;
      SELECT * FROM image_assets ORDER BY id;
      SELECT * FROM bottle_capture_images ORDER BY capture_id, sort_order;
      SELECT * FROM bottle_capture_runs ORDER BY id;
      SELECT id, site_id, user_id, storage_location_id, position_hint, quantity, status,
        workflow_instance_id, imported_bottle_ids_json, error_message, error_detail_json, created_at, updated_at
        FROM bottle_captures ORDER BY id;
      ${identityAlreadyApplied ? "SELECT id, review_candidate_json, review_revision FROM bottle_captures ORDER BY id;" : ""}`,
    afterUpgradeChecks: [
      {
        sql: "SELECT id, vintage_status, vintage_label FROM wine_vintages ORDER BY id",
        expected: [
          [
            { id: "known", vintage_status: "year", vintage_label: "2022" },
            { id: "yearless", vintage_status: "unknown", vintage_label: "Unknown" },
          ],
        ],
      },
    ],
  });
}

void it("the application Wrangler config applies every checked-in SQL migration", () => {
  const state = mkdtempSync(path.join(tmpdir(), "booze-d1-config-"));
  const config = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));
  try {
    localD1(config, state, ["migrations", "apply", "DB"]);
    const result = z
      .tuple([z.object({ results: z.array(z.object({ name: z.string() })) })])
      .parse(
        JSON.parse(
          localD1(config, state, [
            "execute",
            "DB",
            "--command",
            "SELECT name FROM d1_migrations",
            "--json",
          ]),
        ),
      );
    assert.deepEqual(
      result[0].results.map((row) => row.name).toSorted(),
      readdirSync(path.join(root, migrationPath), { recursive: true, encoding: "utf8" })
        .filter((name) => name.endsWith(".sql"))
        .toSorted(),
      "Application migration discovery differs from the SQL history tested in CI",
    );
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

void it("rejects removed, renamed, and edited accepted migrations", () => {
  const base = { "0000.sql": "CREATE TABLE sites (id TEXT);" };
  for (const candidate of [{}, { "renamed.sql": base["0000.sql"] }, { "0000.sql": "SELECT 1;" }]) {
    assert.throws(() => {
      preserveHistory(base, candidate);
    }, /Previously accepted migration/u);
  }
});

void it("accepts independent additions arriving in a different order than fresh replay", () => {
  const base = {
    "0000.sql": "CREATE TABLE sites (id TEXT PRIMARY KEY NOT NULL);",
    "20260101000003_b/migration.sql": "ALTER TABLE sites ADD b text;",
  };
  verifyUpgrade(base, {
    ...base,
    "20260101000002_a/migration.sql": "ALTER TABLE sites ADD a text;",
  });
});

void it("rejects the generated-chain conflict missed by RC4's snapshot checker", () => {
  const base = {
    "0000.sql": "CREATE TABLE sites (id TEXT PRIMARY KEY NOT NULL);",
    "20260101000003_b/migration.sql": "ALTER TABLE sites ADD flag text;",
  };
  verifyUpgrade(
    base,
    {
      ...base,
      "20260101000001_a1/migration.sql": "ALTER TABLE sites ADD flag text;",
      "20260101000002_a2/migration.sql": "ALTER TABLE sites DROP COLUMN flag;",
    },
    { expectedFailure: /duplicate column name: flag/u },
  );
});

const referencedSite = {
  "0000.sql": `CREATE TABLE sites (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL);
    CREATE TABLE memberships (site_id TEXT NOT NULL REFERENCES sites(id));`,
};
const siteFixture = {
  seed: "INSERT INTO sites VALUES ('site', 'Home'); INSERT INTO memberships VALUES ('site');",
  retainedRows: "SELECT * FROM sites ORDER BY id; SELECT * FROM memberships ORDER BY site_id;",
};
function rebuildSite(idExpression: string) {
  return `PRAGMA defer_foreign_keys=ON;
    CREATE TABLE __new_sites (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL DEFAULT 'Home');
    INSERT INTO __new_sites SELECT ${idExpression}, name FROM sites;
    DROP TABLE sites;
    ALTER TABLE __new_sites RENAME TO sites;
    CREATE TABLE __sites_default_fk_guard (violations INTEGER CHECK (violations = 0));
    INSERT INTO __sites_default_fk_guard SELECT count(*) FROM pragma_foreign_key_check;
    DROP TABLE __sites_default_fk_guard;
    PRAGMA defer_foreign_keys=OFF;`;
}

void it("preserves referenced rows during a D1 rebuild with explicit FK validation", () => {
  verifyUpgrade(
    referencedSite,
    {
      ...referencedSite,
      "20260101000001_rebuild/migration.sql": rebuildSite("id"),
    },
    siteFixture,
  );
});

void it("fails a corrupt rebuild inside D1 rather than committing dangling references", () => {
  verifyUpgrade(
    referencedSite,
    {
      ...referencedSite,
      "20260101000001_rebuild/migration.sql": rebuildSite("id || '-corrupted'"),
    },
    { ...siteFixture, expectedFailure: /CHECK constraint failed/u },
  );
});
