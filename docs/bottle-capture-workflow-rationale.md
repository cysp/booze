# Bottle capture extraction workflow rationale

## Caller usage

`BottleCaptureWorkflow` prepares a draft. Only an explicit human confirmation through `importReviewedCapture` can add stock.

1. Claim the queued capture for its reserved Workflow instance.
2. Create an owned capture run.
3. Extract label evidence with the configured `google/gemini-3-flash-preview` model in one durable step.
4. Normalize the model's fields into a typed candidate, retaining invalid label values as validation issues.
5. Write the full extraction artifact and a compact candidate.
6. Record `needs_review`, including warnings and field/image notes.

There is no reconciliation model, confidence threshold for permission, inferred existing-wine selection, or stock-writing Workflow step. The reviewer can create a distinct wine or deliberately select an existing wine ID using bounded search. Selecting a wine does not apply extracted wine metadata to that shared record.

`bottle-ocr.ts` owns the configured model request, prompt, response validation, and raw response. Its Zod schema also generates the provider JSON schema. `bottle-extractor.ts` owns capture-specific image preparation and deterministic conversion from evidence to a candidate. Structured grape arrays remain arrays; punctuation is not a delimiter. Numeric label strings are parsed as complete values, including metric unit conversion and unambiguous comma decimals. Invalid or ambiguous values remain visible as `validationIssues` rather than silently becoming defaults.

## Durable execution and resource bounds

Start, run creation, extraction, artifact writing, and final recording remain separate Workflow steps. The extraction step retains its timeout and one transient retry; a deliberate user retry reserves a new Workflow instance and creates a new run. Each fresh side-effect step checks the current owner, latest run, and `extracting` status. Final run and capture writes are fenced as well, including when an older deployment cached a start/run context without owner fields. Failed, reviewed, historical `importing`, and imported captures are not automatically restarted.

Photos are processed sequentially into JPEG inference copies of at most 2048 by 2048 pixels and 2 MiB each. Originals remain in R2. A normal extraction attempt invokes one model instead of three extractors and a fourth reconciliation model, reducing request payloads and model dependencies. No labeled accuracy corpus exists, and no hosted model calls were used to validate this change; extraction accuracy is unverified.

## Evidence and stored compatibility

New extraction artifacts identify `capture-extraction-v2` and retain:

- capture, Workflow, run, quantity, and image references;
- extractor identity and model configuration, including prompt version;
- the exact provider response as JSON text, parsed field evidence/confidence/notes, raw text by image, warnings, and request diagnostics;
- the normalized candidate, its raw suggestion, validation issues, and review reasons.

D1 keeps the normalized candidate and validation issues for review, omitting the bulky raw suggestion; the full evidence stays in the artifact. Confidence is informational. Unknown clean volume stays omitted, with the review UI explaining the 750 mL default before confirmation. An unparsed volume cannot fall through to that default: it requires a valid corrected value.

Existing multi-model artifacts, raw suggestions, model/run records, import receipts, and image keys are not migrated, rewritten, or deleted. Their generic stored read contracts still expose old disagreements and review reasons. A cached legacy extractor result can continue to review without a new combination call; if its checkpoint predates raw-response/configuration retention, the new artifact explicitly records `legacy_workflow_checkpoint` and null provenance fields rather than inventing them. Historical imported receipts remain authoritative before obsolete candidate parsing. Historical stuck `importing` recovery is outside this change.

## Human confirmation and cleanup

Manual import validates the reviewed snapshot, actor's current write permission, Workflow owner, latest run, review revision, site-scoped wine choice, and destination in the same atomic D1 batch as stock and the completion receipt. There is no preliminary import claim. A failure leaves the draft reviewable; a replay or lost acknowledgement returns the committed receipt without adding bottles again. Notes-only corrections do not clear unresolved numeric evidence. An existing-wine choice can discard wine-field issues, while physical bottle issues still require correction.

Capture-owned multipart manifests and deletion fencing preserve image lifetimes. New captures use unique owned image keys, including duplicate photo content. Cleanup aborts owned multipart work before deleting objects and preserves legacy shared originals/thumbnails. Existing migration history stays unchanged.

## Verification retained

The high-confidence Workflow regression first failed against the automatic-import implementation (`imported` instead of `needs_review`) and then passed with unchanged expectations. A notes-only alcohol correction likewise first imported incorrectly and now remains blocked until correction. Mocked HTTP exercises the full single-model draft path, photos, schema/configuration, artifact provenance, and zero stock. Separate explicit-confirmation tests verify exact quantity, one receipt, replay before old-candidate validation, lost acknowledgements, transaction rollback, natural-key conflicts, permission revocation, owner/revision/site/destination fences, and legacy partial-bottle preservation.

Confidence-threshold, combiner-voting, and inferred-name-matching tests were retired with those production mechanisms. Their required guarantees remain covered by direct field/evidence preservation, numeric parser regression cases, explicit existing-wine selection, distinct wine creation, and atomic human confirmation. Existing inference-image bounds and cross-layer accepted-text tests remain in place.

The provider wire format follows the primary [Zod JSON Schema](https://zod.dev/json-schema), [OpenRouter structured output](https://openrouter.ai/docs/guides/features/structured-outputs), and [Gemini schema](https://aistudio.google.com/docs/structured-output) documentation. Local mocked requests validate the generated schema and representative payloads; they do not establish provider availability or accuracy.
