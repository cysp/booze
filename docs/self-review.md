# Audit self review

This is a historical review of the change identified below, not current implementation guidance. See [implementation status](status.md) and [product contracts](product.md) for the maintained view.

Reviewed on 2026-09-08 against `main` at `bb63ad8`. The original audit started at `5e3d9c6`; its changes were rebased onto current `main` before publication. Current dependency pins, Astryx adaptations, generated theme files, and bundle-budget changes were retained. Existing schema and migrations are unchanged.

The review used independent Standards and Spec passes, plus a persistence review focused on concurrent writes, interrupted imports, Workflow replay, and image retention. The spec is the request to simplify and harden the project, optimise user experience, and preserve stored data, together with [product requirements](product.md) and the [critic-review ADR](adr/0001-critic-review-facts.md).

## Standards

No hard violation of documented repository rules was validated. Four maintenance findings were considered:

1. **Fixed: duplicated request handling accepted stale errors.** The four collection loaders discarded stale successful responses but still allowed older errors and refresh completions to overwrite newer results. One local loader now handles both outcomes, and refresh completion distinguishes superseded requests. Three deferred-response regressions failed before the fix and pass afterward.
2. **Fixed: unused mutation wrappers retained unsafe composition options.** Removed the unused `upsertWineVintage` and `createBottles` wrappers, which committed independently. Callers compose prepared statements into the complete domain transaction.
3. **Fixed: unnecessary global grape lookup.** Removed the full grape-variety read before every constituent edit. Existing IDs are resolved by name in the transaction; new IDs are used only for newly inserted varieties.
4. **Fixed during the mergeability follow-up: duplicated import composition.** Automatic and reviewed imports now share their guarded preparation/receipt commit. Their matching and initial claim conditions remain explicit, and the importer owns both claiming and completion.

## Spec

Eight findings were addressed:

| Finding                                                                                                       | Result                                                                                                                                                                                                                                 | Verification                                                                         |
| ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| An unrelated bottle PATCH could restore a stale wine association after another request reassigned the bottle. | Only an actual reassignment writes `wineVintageId`; notes, consumption, and location changes preserve the association committed by the other request.                                                                                  | Database update injected between the route's read and batch.                         |
| Adding or removing a grape erased percentage and blend text for retained grapes.                              | Explicit edits remove only omitted constituents and preserve the existing rows for retained names.                                                                                                                                     | Measured Shiraz survives replacing Merlot with Cabernet.                             |
| Editing a review source's name retained the old source ID, silently ignoring the correction.                  | A source correction clears the stale ID; editing the rating retains its source and provenance.                                                                                                                                         | Two bottle-editor interaction cases.                                                 |
| Clearing award points left the stored numeric value unchanged.                                                | Replacement writes use SQL NULL for an omitted points value.                                                                                                                                                                           | Points clear preserves the award ID and provenance.                                  |
| The editor described every wine edit as shared even when identity changes affected only one bottle.           | The editor explains that winery, region, and vintage changes reassign the selected bottle; unchanged reviews and awards stay with their original wine.                                                                                 | Source review of the editor and the existing reassignment tests.                     |
| Concurrent review replacements could delete the row that another request had just inserted.                   | Replacement cleanup retains the review-source domain key rather than a speculative generated review ID.                                                                                                                                | Two preparations followed by sequential commits; reproduced deletion before the fix. |
| Concurrent additive review evidence could overwrite the rating, notes, and provenance committed first.        | Additions use a conflict-time no-op; explicit review replacements retain their separate behavior.                                                                                                                                      | Reproduced the overwritten rating and lost notes before the fix.                     |
| Concurrent creation of the same wine could fail after IDs had been prepared.                                  | A known natural-key collision retries the entire preparation and transaction once with current IDs. Other errors are not replayed; repeated collisions return a retryable conflict, and manual captures retain their review candidate. | Interleaved catalogue/import writes, receipt replay, and error-classification tests. |

## Mergeability follow-up

A subsequent critical review reproduced five further defects despite the passing checks. The follow-up fixes concentrate identity and lifecycle rules in the mutation modules:

- Reassigning a bottle to an existing vintage preserves that vintage's blend. Constituent inheritance applies only to a new target, including after a concurrent creation forces preparation to retry.
- Drinking windows are complete pairs. Bottle PATCH requires both endpoints when either changes, the browser submits the pair and explains reversed dates, and additions retain an existing partial window. Validation lives in catalogue preparation so imports cannot bypass it.
- Award INSERT statements resolve the stored ID by their complete identity, including an unknown year, inside the transaction. Additions preserve evidence, replacement cleanup uses identities, and historical duplicate rows are retained rather than guessed away. The preparation read and ID map were removed.
- Review mutation functions resolve identities, own proven-rollback retries, and commit MCP audit statements with the mutation. MCP no longer chooses pending IDs or assembles these batches. Native D1 testing exposed an extended uniqueness-error suffix; the classifier now handles that exact format without replaying unrelated or uncertain failures.
- Current Workflow instances can restart unfinished captures. Automatic and reviewed imports share a guarded commit that verifies ownership and the latest run in the transaction. Manual claiming moved into the importer, and launch failures can only downgrade queued captures. Stale runs cannot commit or reset a newer run's state.

The same review also exposed a pre-existing race when creating a winery without a region. New winery identities now use a full SHA-256 hash of their canonical site/name/region tuple; lookups retain existing stored IDs. This coordinates current writers without rewriting historical records or adding a migration. Concurrent older deployments using random IDs can still create duplicates during a version overlap.

Each reproduced failure has a regression test. The complete-window REST contract is a deliberate compatibility change; callers that previously patched one endpoint must include the other endpoint or explicit `null`. It does not add general optimistic locking: concurrent changes to the same fact still use the last committed value.

## Adversarial follow-up on 2026-09-22

The branch was rebased onto `origin/main` at `316fee9`. Independent reviewers reproduced and challenged three remaining failures before implementation. The agreed product contract preserves viewer roles when reusing a unique shared site, keeps saved photos recoverable after definite launch failure, and retains independent refresh warnings.

- **Fixed: concurrent site creation produced duplicates.** Accessible-name lookup, conditional site/membership insertion, and result lookup now share one D1 transaction. Tests cover simultaneous requests, viewer/editor reuse, ambiguity, rollback, unrelated users, and rename/recreate. Eight concurrent HTTP requests against native local D1 returned one ID.
- **Fixed: a separate Workflow-owner write could strand saved captures.** The initial capture insert now includes the owner. Launch failures retain images and expose a saved-but-startup-unconfirmed response; guarded failure updates preserve any processing that already started. HTTP tests exercise retained image access, retry, deletion, and lost launch acknowledgements.
- **Fixed: unrelated refresh completion could erase a failed section's recovery action.** Warnings are owned by their collection and clear only after a current success for that collection. Status generations separately prevent older operations from replacing newer feedback. Deferred-response tests cover partial overlap, selected retries, background recovery, and multiple failures.

The concurrent maintenance follow-up also restored completed manual-import replay at the HTTP boundary: authorization precedes receipt lookup, while stale candidate/status validation cannot reject an already committed import. This does not recover a process terminated before the import transaction.

A final cross-check also corrected the browser's saved-capture prefix: it no longer claims submission did not occur when startup acknowledgement is uncertain. A second read-only review challenged aggregate completion after a newer collection request had already settled; the regression passes, and no additional scoped defect was validated. Full verification is recorded in the audit.

## Preservation and remaining limits

The rebased build initially exceeded the existing total-JavaScript gzip budget. Native capture disclosures and grouping shared UI modules that already load at startup brought it below the unchanged ceiling. After the follow-up fixes, total JavaScript is 219,609 bytes gzipped, compared with 221,286 before optimization; the initial entry plus preloads is 151,240 bytes, compared with 152,467, measured with Node 24. Lazy editor and capture modules remain lazy. Both light and dark browser runs verify disclosure keyboard behavior, focus, and accessibility.

The review retained the atomic catalogue and import boundaries, unique R2 upload keys, live-reference deletion guards, and unchanged migration lineage. A lost import acknowledgement was tested separately: replay returned the stored receipt and retained the original bottle count.

The [audit's remaining priorities](audit.md#remaining-priorities) still apply. In particular, this work does not provide general optimistic locking, export/restore, complete viewer details, or automatic reconciliation of a manual import terminated between its claim and transaction. It does not reconstruct facts lost before these fixes.

The initial review's four Standards findings and eight Spec findings are addressed, together with the five additional mergeability defects above. Final combined verification is recorded in the [audit](audit.md#verification-boundaries).
