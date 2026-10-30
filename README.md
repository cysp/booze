# Booze

A private wine-cellar catalogue for finding, adding, moving, and consuming physical bottles from a phone. Wines and vintages hold shared facts; bottles hold individual facts and positions. Photo capture assists entry, with uncertain results kept for human review.

## Development

Use Node 24 and the pnpm version pinned in `package.json`.

```sh
pnpm install --frozen-lockfile
pnpm --filter @chikachow/booze-web exec wrangler d1 migrations apply booze --local
pnpm --filter @chikachow/booze-web dev --host 127.0.0.1
```

Local D1 and R2 state lives in `apps/web/.wrangler`. Keep it when restarting development. Local authentication works only on `localhost` or `127.0.0.1` when `CLERK_SECRET_KEY` is absent. Photo extraction requires the configured AI gateway and its credential; manual bottle entry works without them.

For Clerk development, configure `VITE_CLERK_PUBLISHABLE_KEY` in `apps/web/.env.local` and Worker secrets in `apps/web/.dev.vars`. These files are ignored by Git. Production setup and data recovery are described in [deployment](docs/deployment.md).

```sh
pnpm check
pnpm --filter @chikachow/booze-web build
```

`check` first validates the frozen lockfile, declared peer requirements, and
lockfile deduplication. The required CI dependency job runs the same gates and
rejects lockfile changes. Dependency resolution permits intermediate peer
conflicts; peer validation checks the committed lockfile without installing packages
or running lifecycle scripts.
Run `pnpm dedupe --ignore-scripts` to fix avoidable duplication, then review the
lockfile and repeat the checks. Node declarations stay on the Node 24 runtime
major; Dependabot leaves major upgrades for a runtime change.

Fetch current `origin/main` before running checks: the local D1 migration test uses it as the accepted upgrade history. See [migration authoring](docs/drizzle-migrations.md) for generation and parallel edits.

The checks include migrated SQLite and D1 upgrade tests, React interaction tests, generated-theme validation, and Chrome browser tests in light and dark modes. Browser tests require Google Chrome and reserve port 4174. The build checks client bundle budgets.

## Project layout

| Location                                               | Responsibility                                                  |
| ------------------------------------------------------ | --------------------------------------------------------------- |
| `apps/web/src`                                         | React user flows, form state, and catalogue refresh             |
| `apps/web/worker/routes`                               | HTTP authentication, input validation, and responses            |
| `apps/web/worker/api`                                  | Site permissions, catalogue writes, and inventory reads         |
| `apps/web/worker/mcp`                                  | Bounded, site-authorised tools and transactional write auditing |
| `apps/web/worker/bottle-*`, `capture-*`, `deletion.ts` | Durable capture processing and image lifecycle                  |
| `packages/db`                                          | Drizzle schema and append-only D1 migrations                    |

D1 is the source of truth. R2 stores images and extraction artifacts. Cloudflare Workflows coordinates extraction retries. The browser and MCP use the same site roles: owner, editor, and viewer.

See [product intent](docs/product.md), [implementation status](docs/status.md), and the [project audit](docs/audit.md) for the domain model, constraints, and maintenance priorities.
