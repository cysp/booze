# Project audit

This is a historical change record. Its remaining-priority list describes the reviewed revision; see [implementation status](status.md) for current capabilities and work.

Audit date: 2026-09-08. Starting commit: `5e3d9c6`. Scope: product intent, browser flows, HTTP and MCP contracts, authorization, stored-data integrity, capture processing, deployment, dependencies, and verification.

The changes were subsequently rebased onto `origin/main` at `316fee9` on 2026-09-22 and subjected to a [comprehensive self review](self-review.md). Current upstream dependencies and UI-library adaptations were retained.

## Assessment

Booze should answer three everyday questions quickly: what do I have, where is this physical bottle, and what should I drink? Adding bottles should retain evidence and existing facts. A failed operation should leave the catalogue unchanged or expose a durable result that can be safely recovered.

The current architecture fits that purpose. Keep one Worker, one React application, D1 as the source of truth, R2 for images, and Workflows for extraction. Keep wine-vintage facts distinct from physical bottle facts, and preserve critic ratings in their original scales. A framework replacement, additional service tier, generic repository layer, or schema rewrite would add cost without addressing the observed failures.

The main weaknesses were state transitions and data ownership: omitted values were treated as replacement instructions, related writes committed separately, retries lacked a durable import receipt, and grouped inventory obscured which physical bottle an action would affect. The changes concentrate those rules in the existing catalogue, capture, and form modules.

## Findings addressed

| Priority | Failure before the audit                                                                                                   | Resulting behavior                                                                                                                                        | Evidence                                                                      |
| -------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| High     | Adding another bottle could null existing shared wine fields and remove grape constituents.                                | Bottle additions retain existing facts. Explicit edits distinguish an omitted field from a requested clear.                                               | `worker/catalogue-mutations.test.ts`, `src/bottle-payload.test.ts`            |
| High     | A rejected move or later failed review/award write could leave earlier metadata and bottle changes committed.              | Catalogue writes, bottle positions, labels, reviews, and awards commit in one D1 batch.                                                                   | Injected late-write failures in `worker/catalogue-mutations.test.ts`          |
| High     | Truncated deterministic IDs could collapse different awards into one record.                                               | New facts use generated IDs, with existing IDs reused through domain-key lookup.                                                                          | Long-identifier cases in `worker/catalogue-mutations.test.ts`                 |
| High     | Capture imports could stop after claiming a capture or creating only some rows; retries could then skip it.                | Imports persist bottles and a completion receipt together, and replay recognizes committed imports.                                                       | `worker/capture-persistence.test.ts`                                          |
| High     | Reusing an image key after deletion allowed a delayed cleanup job to delete the new image.                                 | New uploads receive unique object keys; existing keys stay valid, and cleanup protects live references.                                                   | Re-upload and concurrent-upload cases in `worker/capture-persistence.test.ts` |
| High     | Deleting a location referenced by a capture could fail after clearing bottle positions.                                    | One batch detaches bottles, captures, and child locations, retaining their site; any failure rolls back all changes.                                      | `worker/storage-locations.test.ts`                                            |
| Medium   | Parent edits could introduce hierarchy cycles or fail obscurely for another site's parent.                                 | Parent existence and site are checked; ancestry validation runs inside the update.                                                                        | Self, descendant, missing, and cross-site parent tests                        |
| Medium   | MCP pagination crashed for non-Latin names, skipped accented names, or returned tokens its own schema rejected.            | Compatible Unicode token encoding, sufficient token capacity, and cursor comparison matching SQLite's case-folding rules.                                 | `worker/mcp-pagination.test.ts` exercises all five SQL-backed lists           |
| Medium   | A grouped wine's Edit action silently chose the first bottle.                                                              | Users can expand a wine and choose the physical bottle and position they intend to change.                                                                | `src/InventoryView.test.tsx`                                                  |
| Medium   | Photo extraction appeared stuck until a page reload; initial load failures offered no retry.                               | Pending captures remain visible and refresh automatically; failed loads offer recovery.                                                                   | `src/useCatalogue.test.tsx`, `src/CaptureView.test.tsx`                       |
| Medium   | Bottle edits overwrote hidden name fields and ignored the edited producer address.                                         | The form emits changed fields, retains hidden identity, and supports explicit numeric clears.                                                             | `src/bottle-payload.test.ts`                                                  |
| Medium   | Maximum-size photos were prepared simultaneously for multiple models, increasing memory pressure.                          | Upload bytes are bounded, inference uses bounded resized copies, and model steps run sequentially while originals remain stored.                          | Capture upload and extractor regression tests                                 |
| Medium   | Missing browser authentication configuration or a failed build could be discovered after migrations.                       | Deployment validates the browser key and builds before applying migrations.                                                                               | `.github/workflows/deploy.yml`                                                |
| Medium   | The starting checkout's runtime dependency audit reported 14 advisories across Hono, fast-uri, ip-address, and qs.         | Retained upstream Hono 4.13.8 and updated the three transitive dependencies within their existing major versions; production audit reports no advisories. | `pnpm audit --prod --json`                                                    |
| Low      | Stored location counts included consumed bottles; empty inventory had no first-site action and search omitted the vintage. | Counts reflect available bottles, first setup has a direct action, and vintage search is included.                                                        | Location, inventory, and catalogue tests                                      |

The SQLite test adapter also now preserves positional columns in joined queries. Its previous object-to-array conversion silently dropped duplicate column names, so it was an unreliable oracle for full inventory reads.

Additional fixes cover several boundary cases:

- Site creation no longer derives identity from a truncated name. It resolves the exact authorized match and creates the site and owner membership in one transaction, so concurrent same-user/name requests converge. Existing shared-site roles are preserved, ambiguity requires an ID, and unmatched names receive a new ID. Renaming a site does not cause a later creation to return the wrong site.
- Site deletion rejects active capture processing, with the guard inside the transaction. Capture retry reservation and workflow ownership checks prevent competing runs from consuming the same work.
- Capture lists hydrate images and latest runs in three queries regardless of list length. Image authorization uses one scoped query, and the review screen links to the retained original photo.
- Capture matching preserves non-Latin text and sends empty normalized identities for review. Conflicting bottles from a historical partial import block completion without overwriting those bottles or issuing a misleading receipt.
- Bottle actions cannot overlap, unsaved edits require explicit discard, and capture review exposes extracted facts and disagreements. A position note requires a storage location, matching the current storage model.
- Reassigning a bottle to an existing vintage retains that vintage's blend. Drinking windows are edited as complete pairs, and additions preserve an existing partial window instead of combining endpoints from different records.
- Award identities, including unknown years, resolve inside the transaction. Review mutations own identity resolution and proven-rollback retries; MCP audit records commit with the corresponding mutation. New wineries with an unknown region use a full hash of their canonical identity, while existing IDs remain valid.
- Automatic and reviewed capture imports share one commit path. The transaction verifies capture ownership and the latest run before writing inventory or a receipt. Current Workflow owners can restart unfinished processing, cached contexts from older deployments remain usable, and launch errors cannot downgrade processing that already started.

The adversarial follow-up also persists the initial Workflow owner with the capture, removing the separate-write failure that stranded saved photos in a queued state. Failed launches expose the saved result and retain Retry/Delete; lost acknowledgements cannot downgrade started processing. Completed manual HTTP imports replay their stored receipt after authorization. Refresh warnings now belong to individual catalogue sections and survive unrelated successes, with separate ordering for operation feedback.

The authorization review examined browser session and MCP OAuth subject handling, site membership and role checks, image access, and development-auth isolation. No production authorization bypass was validated. Production Clerk configuration still requires hosted verification.

## Preservation constraints

No existing migration or schema definition is rewritten. The audit requires no new migration and performs no remote database, bucket, or deployment mutation. Existing record IDs and image keys remain usable; new generated IDs do not rename old records. Tests use disposable SQLite databases and worktree-local development storage.

These fixes prevent further loss through the identified paths. They do not infer facts already erased by old behavior. Check available backups if historical loss is suspected. [Deployment and recovery](deployment.md) describes D1 exports, bookmarks, and why R2 must be protected separately.

## Remaining priorities

1. **Make recovery a product capability.** Add an authorized export covering bottles of every status, wine facts, locations, reviews, awards, and original-image references. Then add consumed-history browsing and a deliberate restore action. Define deletion retention before introducing a soft-delete schema.
2. **Complete the read-only experience.** Viewers can browse inventory but need a details view for notes, sources, reviews, and individual bottle facts without entering an editor.
3. **Bound whole-catalogue reads.** The browser still loads complete inventory and capture summaries; progressive rendering bounds DOM work, not response size. Introduce server pagination once measured catalogue sizes justify it. Preserve stable identity and user-selected filters across pages.
4. **Define concurrent editing behavior.** Changed-field PATCH reduces accidental overwrites, and drinking windows are replaced as complete pairs. These rules do not detect two users changing the same fact concurrently. A revision/precondition contract is preferable to broad replacement or a speculative synchronization layer.
5. **Exercise hosted integrations.** Local tests do not establish production Clerk/OAuth configuration, Cloudflare restart behavior, real image-service memory, model accuracy, or backup recoverability. Use a dedicated test site and maximum-size image fixtures in staging, with observed limits and failure injection.
6. **Strengthen release identity checks.** CI deployment is serialized, but completion order can differ from commit order. Prevent an older successful CI run from deploying over a newer revision, and verify deployed revision/configuration rather than relying solely on `/healthz`.
7. **Keep shared editing explicit.** Metadata belongs to a wine vintage while position, consumption, barcode, lot, and bottle notes belong to a physical bottle. Any future bulk editing or identity reassignment must state which records change and preserve the original evidence.
8. **Finish interrupted-operation recovery.** An abruptly terminated manual HTTP import can remain `importing` if execution stops after its claim and before the atomic batch. Automatic Workflow imports can resume. Historical partial imports and stuck manual imports need explicit reconciliation that checks existing bottles and receipts before allowing another attempt. R2 writes interrupted before metadata persistence can leave orphan objects; any future sweep must prove that a key is unreferenced before deleting it.
9. **Harden general request parsing.** Capture uploads have an enforced byte limit. Other JSON routes still need a consistent bounded parser and malformed-JSON responses. Verify the intended Clerk audience/authorized-party policy against the actual hosted origins before changing authentication policy.

Preparing a site or storage location by name can leave an empty container if a later bottle transaction fails. Winery and wine-vintage preparation is inside the atomic batch. Existing wine facts and bottles remain unchanged; eliminating these empty site/location containers is a smaller follow-up to the transactional fixes. Reassigning a bottle to another vintage deliberately leaves the old vintage's reviews and awards attached to that vintage.

Existing duplicate awards and wineries are retained to avoid discarding evidence. The winery identity fix coordinates current writers; an older deployment that still generates random winery IDs can create duplicates during a version overlap. Review audit records commit atomically with mutations, but their pre-read values can be stale under concurrent edits to an existing record.

Member invitations, movement history, semantic search, and additional enrichment are product extensions. They should follow export/recovery and reliable core flows.

## Verification boundaries

The initial checkout passed formatting, lint, TypeScript, 56 Worker/script tests, 78 React tests, 20 Chrome browser tests, and the production build. The regressions above demonstrate gaps in that baseline.

Final local verification on 2026-09-22 passed:

- `pnpm install --frozen-lockfile`.
- `pnpm check`: formatting, type-aware lint, both workspace TypeScript checks, 153 Worker/script tests, 112 React tests, generated-theme validation, and 22 Chrome tests across light and dark modes. Browser coverage includes keyboard recovery, native capture disclosures, accessibility, reduced motion, 320px reflow, and large catalogues.
- `pnpm --filter @chikachow/booze-web build`, including unchanged client bundle budgets. The entry JavaScript is 86,629 bytes gzipped; total JavaScript is 219,609 bytes gzipped. The entry plus its initial preloads totals 151,240 bytes gzipped. The existing initial-JavaScript gate counts only the entry file, so the preload-inclusive measurement is reported separately.
- `pnpm audit --prod --json`: zero reported advisories across 126 production dependencies at the time of the audit.
- `git diff --check`, and no changes under `packages/db`, including its schema and migrations.

Live local-browser verification used a fresh migrated development database: created a site and storage location, added two bottles, selected bottle 2 from the grouped inventory, moved it from A1 to B2, changed the producer address, and reopened it. Bottle 1 remained at A1, the edited address persisted, and the existing wine note survived. Attempting to close an unsaved edit displayed the discard confirmation. The temporary development server and browser tab were then closed.

Production state, remote migration ledgers, hosted authentication, real model calls, and backup restoration are outside this audit's validation boundary.

Concurrent-write regressions use a transactional SQLite adapter and injected interleavings. A running local Worker with native D1 also verified existing-blend and partial-window preservation, complete-window validation, and concurrent awards, review sources, critic reviews, and wineries with unknown regions. The native runtime exposed extended UNIQUE and NOT NULL error suffixes; regression tests now cover those exact formats without broadening retries to unknown failures.

The 2026-09-22 native D1 follow-up sent eight simultaneous site-creation requests for one user/name: every response returned the same site ID and the list contained one site. Renaming preserved its ID, and creating the old name then returned a new ID. The temporary sites and development user were deleted.

A temporary local Worker probe invoked actual `DB.batch` calls: a stale capture guard rolled back preceding fixture inserts, while a valid guard committed a bottle and receipt without changing the existing run's extractor, prompt, or schema metadata. Workflow orchestration tests separately exercise same-owner restarts and cached contexts from older deployments. These checks do not establish hosted Workflow restart behavior. All temporary probe code, fixture records, and development servers were removed.

## Primary references

- [Cloudflare D1 batch transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [Cloudflare Workflow rules](https://developers.cloudflare.com/workflows/build/rules-of-workflows/)
- [Cloudflare Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
- [SQLite lower() semantics](https://www.sqlite.org/lang_corefunc.html#lower)
- [Hono security advisory and patched release](https://github.com/honojs/hono/security/advisories/GHSA-8j4g-w8fx-2239)
- [fast-uri security advisory](https://github.com/fastify/fast-uri/security/advisories/GHSA-jqff-g426-hqxp)
