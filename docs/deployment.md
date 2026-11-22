# Deployment and data recovery

## Catalogue client cutover

Deploy the shared catalogue operations and stored-ID contract together in #212. The intermediate #211 Worker can return a stored ID to a client that expects the old hashed ID and record inconsistent public IDs in the audit log. Use the deployed #210 Worker if the coordinated cutover needs to be postponed.

When the release switches to stored catalogue IDs, finish or save open edits before deployment. Reload the catalogue in each open browser tab after the release. In an existing MCP conversation, call `cellar.list_sites` and the relevant wine, bottle, or storage-location list/search tool again. Use the newly returned IDs for subsequent detail and write calls. Copy IDs exactly, including any surrounding spaces. An older hashed ID cannot identify the stored record after this cutover.

Repeat the browser refresh when the paged catalogue reads deploy. Verify the new browser can open a detail and fetch a subsequent page. For MCP, verify a newly listed ID opens the expected detail before making a change.

## Configuration

The GitHub `production` environment supplies `VITE_CLERK_PUBLISHABLE_KEY` as a variable and `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` as secrets. The publishable key is compiled into browser assets; setting only a Worker runtime key cannot configure the browser.

Worker secrets include `CLERK_SECRET_KEY` and, for photo extraction, `CF_AIG_TOKEN`. Configure them through Cloudflare outside source control. Non-secret bindings and `CLERK_OAUTH_ISSUER` live in `apps/web/wrangler.jsonc`. The Worker fails closed for MCP OAuth metadata when the issuer is absent or blank.

Local Worker secrets belong in `apps/web/.dev.vars`; browser build variables belong in `apps/web/.env.local`. Both are ignored. See [Cloudflare's environment-variable guidance](https://developers.cloudflare.com/workers/local-development/environment-variables/).

CI builds both without a browser key and with a public test fixture key, enforcing the same bundle budgets for each. Deployment builds again with the production environment's actual key; its exact output must also pass those budgets.

### Bundle regression checks

The bundle limits are review tripwires, not measured user-experience targets. Do not add code or bundler complexity solely to squeeze below a limit; investigate a change and rebaseline deliberate increases when appropriate.

The Astryx 0.7.16 production build uses the library’s Vite plugin to compile the component styles used by the application. Clerk loads the catalogue after sign-in. With the public CI key, the entry and its module preloads measure 552,855 bytes (173,188 gzip), initial CSS measures 213,827 bytes (33,693 gzip), and all JavaScript chunks together measure 453,829 bytes gzip. The total JavaScript limit is 470,000 bytes. The initial JavaScript and CSS limits track the smaller entry.

A cold local Chrome visit to the development-auth inventory using a catalogue fixture requested 342,897 bytes of JavaScript and 33,693 bytes of CSS gzip. Before the source-build and loading changes, the same Astryx version requested 338,907 and 51,473 bytes respectively. This fixture exercises the catalogue UI with local authentication. A real Clerk sign-in also loads the Clerk client.

Initial JavaScript includes each local script and module-preload asset in the built HTML once. It excludes dynamic imports, including Clerk and on-demand catalogue views; total JavaScript includes all emitted chunks. These gzip sizes are comparable build measurements, not a claim about the CDN's compression, cached transfers, browser execution time, or time to usable authenticated content. Evaluate those separately before tuning chunk boundaries.

## Release sequence

`deploy.yml` runs after successful CI for a push to `main` and checks out that tested commit. It checks browser authentication configuration, builds the Worker and browser assets, applies pending D1 migrations, deploys the built output, and probes `/healthz`.

The health route confirms that the Worker responds; it does not verify Clerk sign-in, D1 schema, R2 access, or model extraction. Verify sign-in and a catalogue read after deployment. Use a dedicated test site for any write smoke test.

The wine identity migration has additional release and rollback constraints. Complete the [wine identity release checklist](wine-identity-release.md) before merging it. CI success alone does not satisfy those checks.

### Addition receipts and capture uploads

Deploy the shared-image writer from #222 before applying the capture upload migrations in #210. Until the first write with #210, that writer can serve the migrated schema. From the first write, keep #210 as the earliest Worker rollback target. Earlier Workers cannot replay addition receipts or drain multipart cleanup records. If #210 itself needs repair after that point, deploy a forward fix that preserves the receipts, upload manifests and cleanup queue.

## D1 migration lineage

Migrations `0000` through `0008` establish the original lineage. A comment-only v1 baseline follows them; subsequent generated migrations use timestamped folders. Keep every existing SQL file unchanged and in order. Schema changes append a new migration; do not replace history with a generated initial migration, rename old files, or hide mismatches with `IF NOT EXISTS`.

Drizzle Kit exports the current TypeScript schema as SQL DDL for inspection and database management:

```sh
pnpm --filter @chikachow/booze-db exec drizzle-kit export
```

Export describes the desired schema; it does not export stored data or apply a database change. Wrangler applies the checked-in SQL migrations and tracks their application. See the [Drizzle export documentation](https://orm.drizzle.team/docs/drizzle-kit-export).

`pnpm --filter @chikachow/booze-db test` compares that export with a fresh SQLite database built from every checked-in SQL migration. It checks tables, columns, keys, indexes, and table options while allowing column order and foreign-key numbering to differ. The database tests also validate the snapshot graph and no-change generation. `pnpm check` additionally tests upgrade from the accepted target history on populated local D1. These checks do not read production. See [migration authoring, concurrent edits, and D1 rebuilds](drizzle-migrations.md).

Before a release that adds a migration, read the **applied ledger** and compare it with the accepted deployed history and the proposed release's checked-in filenames:

```sh
pnpm --filter @chikachow/booze-web exec wrangler d1 execute booze --remote --command 'SELECT id, name, applied_at FROM d1_migrations ORDER BY id' --json
git ls-tree -r --name-only HEAD -- packages/db/migrations
pnpm --filter @chikachow/booze-web exec wrangler d1 migrations list booze --remote
```

Compare only `.sql` paths, relative to `packages/db/migrations/`, with the ledger names. Every applied name must be accounted for; missing accepted migrations, unknown names, or an unexplained order are stop conditions. The only unapplied files should be the reviewed release additions. `migrations list` lists pending files; it does **not** expose unknown applied entries and is not a lineage check by itself. The ledger contains no SQL checksums: also verify immutable SQL against the recorded deployed source revision and inspect the exported schema. [Cloudflare migration tracking](https://developers.cloudflare.com/d1/reference/migrations/).

Reconcile any disagreement against the deployed lineage before applying anything. Do not insert ledger records to make the check pass. Migration `0008` adds the durable R2 deletion queue; earlier migrations established the catalogue, captures, reviews, awards, and audit log.

Migration `0003` historically removed inline OCR evidence columns. Do not apply it to an old database that still holds that evidence without first exporting and retaining it. This audit preserves the checked-in lineage; it does not reverse historical evidence removal.

## Recovery preparation

Keep a D1 export and its recovery bookmark in a private backup directory outside the repository before a data-changing release. These commands read the remote database; choose an output filename that does not overwrite an existing backup:

```sh
pnpm --filter @chikachow/booze-web exec wrangler d1 time-travel info booze --json
pnpm --filter @chikachow/booze-web exec wrangler d1 export booze --remote --output /absolute/private/backup/booze-before-release.sql
```

D1 [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) has a retention window determined by the account plan. An [SQL export](https://developers.cloudflare.com/d1/best-practices/import-export-data/) provides a separate portable snapshot. Neither includes R2 image bytes.

Preserve original images independently when preparing a full recovery point. A D1 rollback alone cannot restore an object already deleted from R2, and restoring an old deletion queue can reintroduce pending deletions. Pause capture processing and cleanup before a coordinated recovery; restore D1 and R2 to a consistent point, inspect pending cleanup keys, then resume. Rehearse recovery against a separate database and bucket before using it on production.

### Test the export as a restore input

A completed export is not proof that D1 can import it unchanged. The wine identity release rehearsal on 2026-09-22 found two independent failures with the real export: inserts appeared before referenced tables existed, and large saved extraction text exceeded the SQL statement size accepted by local D1. Creating the schema first resolved only the first failure.

Keep the original export unchanged and checksummed. If an isolated import fails, prepare a separate restore copy for that snapshot:

1. Create all tables and required indexes before inserting rows; use deferred foreign-key checks while loading related tables. Preserve the applied migration ledger as data rather than recreating or guessing it.
2. Bound statement sizes without truncating values. The tested copy inserted rows and then appended large text in bounded updates addressed by the original row ID. It preserved SQL quoting, nulls, blobs, and autoincrement state. This method was validated for that snapshot; tables without row IDs, triggers, generated columns, or constraints on intermediate values require separate handling and another rehearsal.
3. Import into a fresh private local D1 persistence directory. Compare the restored schema and every application row with the original export, including IDs, relationships, full extraction text, and ledger values. Require an empty foreign-key check. Counts alone cannot detect changed values. Document any excluded platform metadata explicitly.
4. Keep this recovery test separate from the migration rehearsal. Apply the exact candidate migrations to another restored copy, verify only the intended transformations and ledger additions, and require a no-op second migration application.

The successful rehearsal used a snapshot-specific builder and comparator retained with the private backup. They are recovery artifacts, not general migration tooling. Keep their dependencies, input/output checksums, exact commands, tool versions, and comparison results with the backup so recovery does not depend on a temporary worktree. Do not copy production exports or extraction evidence into this repository.

Use the verified restore copy for subsequent local rehearsals, from the matching checkout with dependencies installed:

```sh
umask 077
BOOZE_RECOVERY_TEST=$(mktemp -d)
pnpm --filter @chikachow/booze-web exec wrangler d1 execute booze --local --persist-to "$BOOZE_RECOVERY_TEST" --file /absolute/private/backup/recovery/before-bounded.sql
pnpm --filter @chikachow/booze-web exec wrangler d1 execute booze --local --persist-to "$BOOZE_RECOVERY_TEST" --command 'PRAGMA foreign_key_check' --json
```

The commands above do not replace the full data/schema comparison. Never import a restore copy over an existing populated database. A local rehearsal does not itself authorize or prove a production restore: choose the recovery point, preserve later writes, and coordinate D1, R2, and the compatible Worker before any production recovery.

No production restore, migration, or object cleanup is part of the project audit. Existing metadata or photos lost before a fix require recovery from an available backup; code changes cannot reconstruct them reliably.
