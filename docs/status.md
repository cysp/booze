# Implementation status

Booze is a private mobile-first wine-cellar catalogue with a React/Vite browser application and one Cloudflare Worker. `packages/db` contains the Drizzle schema and append-only D1 migrations. See [product intent](product.md) for maintained domain contracts and the [historical project audit](audit.md) for earlier findings.

## Available workflows

- Clerk browser sign-in and localhost-only development authentication.
- Bounded inventory search by wine, vintage, location, notes, reviews, and awards; a drink queue derived from drinking windows. Full counts and facets accompany pages of summaries.
- Bottle entry with quantity, wine metadata, source details, critic reviews, awards, and optional storage position.
- Individual bottle selection within grouped wines, full read-only details, and focused actions for movement, bottle facts, shared wine corrections, reassignment, consumption, restoration, and deletion.
- Searchable consumed history using the same bounded reads and stored bottle identities.
- Site and nested-location creation, renaming, and deletion. Deleting a location preserves its bottles, captures, and child locations within the site.
- Photo capture with stored originals, bounded image preparation, one extractor, retained evidence, and explicit confirmation before stock is added.
- Capture summaries and selected details, bounded progress polling, repeatable launch, retry, and deletion with durable R2 cleanup.
- Site-authorised MCP inventory and management tools using stored IDs and shared catalogue operations.
- On-demand bottle/capture details and wine choices, including wines without bottles. Inactive areas do not load their collections.

## Data and permissions

Owners can manage their site and its content. Editors can change content but cannot rename or delete the site. Viewers are read-only. The Worker enforces these roles independently of the browser.

Wine metadata is shared by a wine-vintage record. Individual bottles retain their own status, notes, barcode, lot, and location. Adding stock preserves existing wine facts; explicit edits and clears follow different rules from additions. Related mutations commit atomically. Browser and MCP bottle, location, wine-window, and critic-review operations commit permission checks, actual before/after audit facts, and writes together.

Bottle additions and capture submissions use durable operation IDs. Reviewed capture imports commit stock and receipts together without a separate importing claim. Lost acknowledgements can be replayed without duplicating stock. Canonical resources retain numeric values, literal array elements, and stored IDs; historical values outside new-entry limits remain readable for correction.

D1 is the source of truth. Original images and extraction artifacts live in R2. New originals are capture-owned; old shared assets remain valid. Explicit capture/site deletion queues cleanup transactionally and aborts pending multipart writes before deleting their keys. Scheduled maintenance retries queued launches every five minutes and R2 cleanup hourly. Audit rows and addition receipts survive site deletion so old operations cannot recreate deleted results. Existing IDs, evidence, originals, and accepted migration history are preserved.

## Remaining product work

Member invitations, consumption dates, movement history, richer enrichment, and semantic search remain extensions. Concurrent edits to the same fact still use the documented last-commit behavior; revision preconditions beyond capture review and shared-edit scope require a separate product decision.

Hosted Clerk/OAuth configuration, real model accuracy and latency, and production Workflow behavior require environment-specific validation. Local native D1/R2/Workflow checks establish the exercised binding behavior, not those hosted outcomes. Historical partial imports are left intact rather than guessed into a new state.

## Development and deployment

[README](../README.md) has local setup and verification commands. `pnpm check` runs formatting, lint, TypeScript, Worker/SQLite tests, React tests, theme validation, and Chrome interaction/accessibility tests. The browser gate includes manual stock lifecycles and lost-acknowledgement retries against the real local Worker and native D1 in disposable state, alongside the focused mocked interaction suite. A separate production build enforces client bundle budgets.

GitHub CI gates production deployment. Deployment checks browser authentication configuration and builds before applying D1 migrations, then deploys and probes Worker liveness. See [deployment and recovery](deployment.md) for configuration, migration lineage, and backup procedures. Live Clerk, hosted extraction, and production recovery need environment-specific validation.
