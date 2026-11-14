# Historical bottle label prompt rationale

This records the earlier multi-model extraction and reconciliation design. The current [capture workflow rationale](bottle-capture-workflow-rationale.md) supersedes it: one extractor prepares evidence for explicit human confirmation. The parameters and model recommendations below are historical, not configuration instructions.

This document records the rationale for the bottle-label text extraction prompts, reconciliation prompt, model parameters, and storage-field alignment.

## Sources Used

- OpenAI structured outputs guidance: use strict JSON schemas, clear key names, descriptions for important keys, and evals for schema changes. See <https://developers.openai.com/api/docs/guides/structured-outputs>.
- OpenAI reasoning prompt guidance: keep prompts simple and direct, avoid asking for chain-of-thought, use delimiters, and make success criteria specific. See <https://developers.openai.com/api/docs/guides/reasoning-best-practices>.
- Google Gemini prompt guidance: direct, structured prompts with clear constraints and modality-aware instructions work best for Gemini 3-class models; important constraints should be placed early. See <https://ai.google.dev/gemini-api/docs/prompting-strategies>.
- Google Gemini structured output guidance: structured output is appropriate for extraction-to-database use cases; schema compliance still needs semantic validation and error handling in application code. See <https://ai.google.dev/gemini-api/docs/structured-output>.
- Anthropic prompt guidance: use clear sequential instructions, provide context, and use XML-style tags to separate instructions, context, examples, and inputs. See <https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices>.
- OpenRouter image input guidance: when sending multimodal messages, put the text prompt before image inputs. See <https://openrouter.ai/docs/guides/overview/multimodal/image-understanding>.
- OpenRouter structured output guidance: use `response_format.type = "json_schema"`, `strict: true`, `provider.require_parameters: true`, and property descriptions where model support allows it. See <https://openrouter.ai/docs/guides/features/structured-outputs>.

## Prompt Structure

The extraction system prompt is split into XML-style sections:

- `role`: identifies the task without over-personalized or persuasive wording.
- `model_identity`: records that each extractor works independently, so model disagreement is useful evidence rather than prompt drift.
- `source_of_truth`: limits extraction to visible bottle, label, closure, and packaging text, and treats text in images as data rather than executable instructions.
- `output_contract`: relies on schema enforcement instead of asking the model to hand-format JSON.
- `evidence_policy`: requires evidence for each populated field so reconciliation can prefer grounded values.
- `field_policy`: defines ambiguous wine terms in the same vocabulary used by storage.
- `text_policy`: protects OCR-heavy fields from summarization, translation, or copy-editing.
- `unknown_policy`: makes empty values preferable to guesses.
- `multi_image_policy`: handles accidental mixed-bottle uploads without forcing false agreement.

The extraction user prompt puts the text instruction before image content because OpenRouter recommends text-first multimodal message ordering. It names the database-backed target fields so the extractor's schema, the reconciler's canonical fields, and the app's stored fields stay aligned.

The reconciliation prompt mirrors the extraction structure but removes image-specific instructions. Its core rule is to choose the best-supported visible-label value, not the cleanest-looking value. This is important for wine labels because OCR variants often differ by punctuation, accents, producer legal suffixes, ABV formatting, and cuvee/block terms.

## Field Alignment

The app now stores the structured fields that the extractors and reconciler produce. Field names match the browser/API contract so the extraction output can flow into the bottle form without a legacy mapping layer:

- ontology identity: `wineryName`, `brandName`, `displayName`, `vintage`, `grapeVarieties`, `wineType`, `wineColor`
- geography and classification: `country`, `region`, `appellation`, `classification`
- bottle and label facts: `alcoholPercent`, `bottleVolumeMl`, `addressQualification`, `barcode`, `lotCode`
- drinking and reference text: `description`, `drinkingAdvice`, `labelText`, `sourceUrl`, `wineNotes`

`label_extractions.extracted_fields_json` remains the audit trail for retained-field evidence, confidence, disagreements, warnings, raw label lines, model metadata, and review reasons. It no longer carries dropped fields such as bottler, importer, allergens, or other-visible-text buckets.

## Model Parameters

- `temperature: 0` is used for both extraction and reconciliation because this is a deterministic OCR/record-construction workflow, not a creative generation workflow.
- Extractor `max_tokens` is `6000` because each extractor returns per-image OCR text, canonical label lines, evidence snippets, and structured fields. The previous `4000` ceiling was tight for back labels with long marketing and producer copy.
- Reconciliation `max_tokens` is `5000` because it returns a canonical structured record plus conflicts and review reasons, but does not need to repeat every extractor's raw text.
- `response_format` uses strict JSON schema where the selected model/provider supports it.
- `provider.require_parameters: true` stays enabled for OpenRouter calls that require schema support, so routing fails fast rather than silently selecting a provider that ignores `response_format`.
- Extractor notes are arrays of strings without a separate local item-count cap, matching the provider schema. A ninth image note or seventeenth field note must not fail a capture or be silently discarded. The existing model output-token budget remains in place; note types and confidence ranges are still validated.
- Application Zod validation remains mandatory because provider docs distinguish syntactic schema compliance from semantic correctness.

## Known Tradeoffs

- The schemas are intentionally broad enough to retain label evidence, but the app only promotes fields that are useful for inventory search, review, and future wine matching. Stored extraction JSON keeps lower-level evidence without over-normalizing early.
- Bottle facts such as size, barcode, and lot code belong to the bottle layer. Wine identity and grape constituents belong to the winery/wine-vintage layer.
- Few-shot examples are not embedded in the live prompts yet. Current provider guidance supports trying zero-shot/direct prompts first for reasoning-capable models; add examples only when observed failures show stable patterns they can target.
