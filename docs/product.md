# Booze Product Requirements

## Product Summary

Booze is a private, browser-based wine cellar catalogue for non-technical users. It tracks storage sites, storage locations, wineries, collapsed wine-vintage records, grape constituents, physical bottles, drinking windows, source details, label text, and notes. The app is mobile-first because bottles are usually entered, moved, or checked while standing near a rack, fridge, or box.

The product runs as a Cloudflare Worker with a React/Vite frontend, Hono API routes, Cloudflare D1 storage, and Clerk authentication. Local development may use a development auth header when Clerk keys are not configured.

## Current MVP

The current usable product supports:

1. Clerk-backed browser access, with a localhost development auth workaround.
2. Separate bottle management and storage-location management areas.
3. Mobile and desktop responsive layouts.
4. Site and storage-location creation.
5. Storage-location rename within an authorised site.
6. Storage-location deletion that leaves affected bottles in the same site without a location.
7. Site creation, rename, and deletion.
8. Bottle entry with winery, brand, wine name, vintage, grape varieties, region, wine style, drink window, source URL, label text, wine notes, bottle notes, quantity, site, optional storage location, and position.
9. Bulk bottle creation for one wine entry.
10. Available inventory search.
11. A drink queue for bottles that are ready, soon due, or past their drink window.
12. Bottle moves between known storage locations or back to no location.
13. Marking bottles consumed so they disappear from available inventory.
14. Storage-location cards with available bottle counts.

The current app intentionally keeps bottle capture, bottle display, and location management in separate UI contexts. This reduces accidental data manipulation while browsing inventory and keeps the common mobile workflows short.

## Primary Users

### Cellar Owner

The cellar owner needs to:

1. create storage sites and locations;
2. enter bottles quickly from a mobile browser;
3. find where a bottle is stored;
4. see what should be drunk now or soon;
5. mark bottles consumed;
6. keep enough notes and source links to trust the catalogue later.

### Trusted Household User

A trusted user needs to view and manage bottles in shared sites after signing in. The data model already has site memberships, but explicit invite/member management is not implemented yet.

### AI Client

An MCP-capable AI client is an authenticated user of site-authorised inventory tools. It receives no arbitrary SQL access. Bounded write tools use the same database-backed site roles as the browser API and record an audit event atomically with each mutation.

## Core Concepts

### Site

A top-level storage context such as `home`, `wine fridge`, `offsite storage`, or `parents house`.

### Storage Location

A storage position inside a site, such as `left rack`, `shelf 2`, or `box 4`. The data model supports parent locations so racks, shelves, bins, and slots can be represented without separate rack-specific tables. The UI supports optional containing locations while keeping a top-level location quick to create.

### Winery

The producer or estate record for one site catalogue. Wineries can be reused across multiple named wines and vintages.

### Wine Vintage

The bottle-facing wine record. It intentionally collapses UC Davis `Wine` and `Vintage` for v1: winery, brand, display name, designation, style, colour, geography, vintage, drink window, ABV, label text, and grape constituents live together because the app treats different vintages as distinct catalogue entries.

### Bottle

A physical bottle row with status, optional bottle facts, and notes. Its current storage position is represented by a separate bottle-location row. Multiple bottle rows are created when quantity is greater than one.

## Functional Requirements

## Authentication

The app must:

1. use Clerk for browser sessions when Clerk is configured;
2. verify Clerk session tokens on API requests;
3. map Clerk user IDs to internal users;
4. reject unauthenticated API access outside local development;
5. allow local development with `x-dev-user` only on localhost when `CLERK_SECRET_KEY` is absent.

## Authorisation

The app must:

1. enforce site membership server-side for site-scoped data;
2. prevent cross-site bottle and storage-location access;
3. create an owner membership only for a newly created site; reusing a site preserves the existing membership role;
4. avoid frontend-only access control;
5. allow owners to manage a site and its content;
6. allow editors to mutate site content but not rename or delete a site;
7. keep viewers read-only.

## Bottle Management

The app must support:

1. entering one or more bottles;
2. storing wine metadata and notes;
3. storing label text manually;
4. selecting a site and optional location by their stored IDs;
5. moving a bottle to another known location;
6. marking a bottle consumed;
7. searching available inventory;
8. showing drink status derived from the drink window.

The drinking window is edited as one fact: both endpoints are submitted together, with `null` for an unknown endpoint. The browser still presents separate Drink from and Drink to fields. REST bottle PATCH callers must send both fields when changing either one; MCP already uses this contract. Concurrent edits replace the complete window, and the last committed edit wins. Adding bottles can supply a window only when both stored endpoints are unknown; it cannot combine endpoints from different records.

Changing a bottle's wine identity can reuse an existing wine vintage or create a new one. Reusing an existing vintage preserves its grape blend. A new vintage can inherit the original wine's constituent measurements; the original vintage's reviews and awards remain attached to it unless explicitly edited.

Adding bottles or submitting photos requires an operation ID and an explicit site ID. Repeating the same operation returns its original result; changing its content under the same ID conflicts. The receipt and catalogue writes commit together. A lost acknowledgement must not create additional stock, and deleting the result must not make replay recreate it.

HTTP and MCP bottle, location, wine-window, and critic-review operations share complete domain operations. Their permission guard, mutation, and audit facts commit in one batch. Audit snapshots describe the state at that commit, rather than a later resource read. An unchanged request reports a successful no-op with no invented mutation.

Resource representations keep stored IDs, numeric values, and array elements intact. New-entry validation is separate from reading historical values: an old value outside today's entry limits remains visible for deliberate correction. Neither renaming a site or location nor punctuation within a grape name changes its identity.

## Catalogue Reads

Inventory, wine choices, and captures use server pages with a default limit of 50 and a maximum of 100. Cursors use immutable creation time and stored ID, remain tied to the caller and filters, and are opaque to clients. Inventory pages return summaries, full matching counts, and facets; bottle and wine details load by authorized ID. Wine choices include records with no bottles. Sites and storage locations remain shared lightweight directories.

The browser requests the active area's pages and loads more only on demand. Group counts describe bottles shown, not an assumed complete group. Free-text search runs over stored wine, bottle, location, review, and award facts, including fields omitted from summaries. Search treats `%`, `_`, and quotes literally; SQLite folds ASCII case, while other Unicode text requires matching case.

`GET /api/bottles` defaults to `status=in_stock`; `consumed` and `any` are explicit alternatives. `GET /api/bottle-captures` defaults to the action view, which includes processing and review work but excludes imported captures. Compact status reads track known captures independently of the current page. A missing tracked capture can invalidate inventory without being presented as a successful import.

## Location Management

The app must support:

1. creating locations by site;
2. editing location names;
3. deleting locations;
4. listing locations separately from bottle workflows;
5. showing available bottle counts;
6. using a location as the target for new bottle entry.

Deactivate, capacity, and short location codes are not implemented. Parent/child locations are supported; parent edits must stay within one site and cannot introduce cycles.

Deleting a location must set affected bottles and captures to a location-less state while preserving their site association. Child locations become top-level locations in the same site. These changes must commit together.

## Site Management

The app must support:

1. creating sites;
2. editing site names;
3. deleting sites;
4. listing sites with bottle and location counts.

Creating a site by name reuses the sole exact-name site accessible to the user, including a shared site where the user is a viewer, without granting additional permissions. Concurrent requests from the same user for the same name must return the same site. Separately shared sites may have duplicate names; ambiguous name-based operations must require a site ID. Renaming a site retains its ID.

Deleting a site removes its bottles, wine vintages, locations, memberships, and site row. This is intentionally different from deleting a location, because a bottle cannot remain associated with a deleted site.

## Drink Queue

The app must calculate:

1. `unknown` when no drink window is present;
2. `hold` when current year is before `drink_from_year`;
3. `past-window` when current year is after `drink_to_year`;
4. `drink-soon` when within two years of `drink_to_year`;
5. `drink-now` otherwise, when inside or past the start of the window.

The current drink queue displays `drink-now`, `drink-soon`, and `past-window` bottles.

## Image and Enrichment Requirements

Photo capture accepts multiple images, stores originals in R2, and runs asynchronous extraction to prepare a draft. Every capture requires deliberate human confirmation before adding stock. Confidence is evidence for review and never authorizes a catalogue write. Manual entry remains available without extraction services.

One configured extractor supplies label text, field evidence, warnings, and a normalized candidate. The original response and run configuration remain in the extraction artifact. The model's accuracy is not established by schema validation; unsupported or ambiguous measurements must remain reviewable rather than becoming guessed numbers.

New originals belong to their capture and use immutable object keys. Duplicate bytes do not create shared ownership between new captures. Preview transformations happen on read; historical shared assets and stored thumbnails remain valid. Originals remain available for the capture's lifetime and are removed only through explicit capture or site deletion.

Image processing must:

1. store photos in R2, not D1;
2. keep R2 artifacts retryable and D1 as the source of truth;
3. retain candidates and evidence for authorised manual review;
4. durably reserve upload ownership before writing bytes;
5. durably queue object deletion, abort unfinished multipart uploads before deleting their keys, and retry failed cleanup.

If photos are saved but extraction startup is unconfirmed, retain the queued capture and its launch identity. Submission replay, explicit retry, and bounded scheduled dispatch use that same identity. An uncertain acknowledgement must not downgrade started processing or allocate a competing run. The current Workflow owner and latest run fence finalization; saved review revisions fence confirmation. Historical partial imports are not inferred or rewritten by this lifecycle.

Reviewed stock, locations, and the import receipt commit together. Saving a draft does not add stock. Unresolved label measurements cannot be dismissed by saving an unrelated note; selecting an existing wine preserves that wine's facts but still requires valid physical bottle facts. When a label supplies no size, the review must make the 750 mL default explicit before confirmation.

Trusted wine enrichment from winery pages, technical sheets, Vivino pages, or reviews is desirable but not required for MVP. Any enrichment must preserve source URLs and should not overwrite user-entered facts without review.

## MCP Requirements

The `/mcp` endpoint exposes `cellar.*` inventory and management tools. The [server tool definitions](../apps/web/worker/mcp/server.ts) are authoritative for the available surface. Tools return the exact stored IDs used by HTTP; clients must use those IDs rather than derive aliases from names.

MCP tools must authenticate callers, enforce site membership, return structured JSON, avoid arbitrary SQL, and keep each write scoped to an explicit domain action. Write tools should expose narrow inputs, validate ownership before mutation, report the affected records, and persist audit context to investigate accidental or agent-triggered changes.

MCP read and write authorisation requires valid Clerk OAuth identity plus server-side site membership and domain-action checks. Audit event identifiers stay server-private and are not exposed in tool results. Mutation results return committed before/after facts and affected-record counts.

The primary MCP client is ChatGPT. Tool results treat `structuredContent` as the canonical data channel and keep textual content terse instead of duplicating serialized JSON.

## Non-Functional Requirements

## Usability

The app should be comfortable on a mobile browser:

1. touch targets are large enough for one-handed use;
2. the capture form is grouped into short sections;
3. bottle management and location management are separate areas;
4. inventory and drink views avoid accidental edit fields except deliberate move/consume controls;
5. desktop layouts use available width without changing the underlying workflows.

Active pages, details, and shared directories own their refreshes. Each failed section keeps its warning and retry action until a current refresh succeeds. A committed mutation is reported as saved even when reloading its data fails; older requests must not overwrite newer queries, actors, drafts, or operation feedback.

## Security

The system must:

1. require authentication for non-health endpoints;
2. store secrets outside source control;
3. enforce membership checks on the Worker;
4. avoid arbitrary SQL or administrative endpoints;
5. validate uploaded images, store them in R2 only for the capture lifetime, and remove them through the durable deletion queue.

## Reliability and Portability

The system should:

1. keep D1 as the source of truth;
2. keep migrations in source control;
3. use explicit text IDs;
4. make future CSV export/import possible;
5. treat AI indexes and OCR output as rebuildable derived data.

Current capabilities and remaining work are maintained in [implementation status](status.md). Detailed capture boundaries are documented in the [workflow rationale](bottle-capture-workflow-rationale.md).

## Success Criteria

The MVP is useful when:

1. adding a normal bottle takes less than 30 seconds after the user knows the wine details;
2. finding a bottle by search or location takes less than 10 seconds;
3. drink queue surfaces bottles that would otherwise be forgotten;
4. a non-technical user can manage sites, storage locations, and bottles from a phone;
5. server-side membership checks prevent cross-site data leakage.
