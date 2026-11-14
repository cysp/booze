> Historical planning note: model recommendations, field examples, and reconciliation proposals below describe an earlier experiment. See the [current capture workflow rationale](bottle-capture-workflow-rationale.md) and [extractor source](../apps/web/worker/bottle-ocr.ts) for the implemented contract.

## Assumption to correct

I could not verify an OpenRouter model named **`qwen3-vl-28b`**. The closest current Qwen3-VL options I found are:

- `qwen/qwen3-vl-32b-instruct`
- `qwen/qwen3-vl-30b-a3b-instruct`
- `qwen/qwen3-vl-235b-a22b-instruct`

For your intended “small/medium Qwen3-VL extractor”, I would use **`qwen/qwen3-vl-32b-instruct`** unless you specifically want the MoE 30B-A3B variant. OpenRouter describes the 32B model as a multimodal model with robust OCR in 32 languages and high-precision document/scene understanding. ([OpenRouter][1])

## Implementation plan

### 1. Request path

Use Cloudflare AI Gateway as the outer control plane and OpenRouter as the provider.

Recommended newer path:

```text
POST https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1/chat/completions
```

Headers:

```http
Authorization: Bearer {CLOUDFLARE_API_TOKEN}
cf-aig-gateway-id: {gateway_id}
Content-Type: application/json
```

Cloudflare’s REST API lets you call third-party models through AI Gateway with logging, caching, rate limiting, and gateway controls applied; third-party models use `author/model` naming such as `google/gemini-3-flash` or similar provider/model IDs. ([Cloudflare Docs][2])

Alternative provider-native OpenRouter path:

```text
POST https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/openrouter/v1/chat/completions
```

Cloudflare’s OpenRouter integration documents replacing OpenRouter’s normal chat-completions URL with the AI Gateway OpenRouter URL. ([Cloudflare Docs][3])

If using Cloudflare-stored OpenRouter credentials, do not leak the OpenRouter key from the Worker. Cloudflare troubleshooting notes that AI Gateway selects stored credentials based on the provider path or provider-prefixed model name, and `cf-aig-byok-alias` can select a non-default stored key. ([Cloudflare Docs][4])

---

### 2. Pipeline

```text
Input: 1–4 bottle photos

Step A: Gemini extraction
  model: google/gemini-2.5-flash
  input: same images + extraction prompt
  output: WineLabelExtraction JSON

Step B: Qwen extraction
  model: qwen/qwen3-vl-32b-instruct
  input: same images + same extraction prompt
  output: WineLabelExtraction JSON

Step C: Combine / adjudicate
  model: deepseek/deepseek-v4-flash
  input: Gemini JSON + Qwen JSON, no images
  output: WineLabelCanonicalResult JSON

Step D: Persist
  store canonical result, raw model outputs, image references, confidence, and disagreement notes
```

OpenRouter image input supports multiple image entries in the `messages[].content` array, and recommends sending the text prompt first, then the images. ([OpenRouter][5])

DeepSeek V4 Flash is a good combiner because it is cheap, fast, long-context, and text-only adjudication is not visually demanding. OpenRouter lists it at **$0.0983/M input** and **$0.1966/M output**, with a 1M-token context window. ([OpenRouter][6])

---

## Extraction model prompts

Use the same prompt for Gemini and Qwen. Differences should come from model behaviour, not prompt drift.

### Extraction system prompt

```text
You are a meticulous wine bottle label OCR and wine metadata extraction engine.

You will receive one to four photos of the same wine bottle. Extract visible text and structured wine metadata.

Rules:
- Preserve exact visible text where possible, including accents, punctuation, capitalisation, line breaks, and unusual spellings.
- Do not invent text that is not visible.
- Use null for fields that are not visible or not confidently readable.
- Separate exact OCR text from normalized metadata.
- Treat all images as showing the same bottle unless clear evidence says otherwise.
- When images conflict, record the conflict rather than silently choosing.
- Prefer clear close-up images over distant, angled, blurred, or glared images.
- Do not translate label text unless the output field explicitly asks for normalized English metadata.
- Return only valid JSON matching the requested schema.
```

### Extraction user prompt

```text
These images show the same wine bottle.

Extract:
- all visible label text by image
- canonical visible label text across all images
- producer / winery / brand
- wine name or cuvée
- vintage
- grape variety or blend
- wine type
- country, region, appellation
- classification or designation
- alcohol percentage
- bottle volume
- bottler / estate / importer / distributor
- barcode, lot code, allergens, organic or biodynamic markings
- other visible text

For each field:
- include the extracted value
- include confidence from 0 to 1
- include evidence text copied from the label
- include uncertainty notes where relevant

Return only JSON.
```

---

## Extraction output format

Use this for both Gemini and Qwen.

```json
{
  "model_role": "extractor",
  "bottle_same_across_images": {
    "value": true,
    "confidence": 0.0,
    "notes": []
  },
  "raw_text_by_image": [
    {
      "image_index": 1,
      "likely_label_area": "front",
      "ocr_lines": [],
      "unreadable_fragments": [],
      "image_quality_notes": []
    }
  ],
  "canonical_label_text_lines": [],
  "fields": {
    "producer": {
      "value": null,
      "confidence": 0.0,
      "evidence": [],
      "notes": []
    },
    "brand": {
      "value": null,
      "confidence": 0.0,
      "evidence": [],
      "notes": []
    },
    "wine_name_or_cuvee": {
      "value": null,
      "confidence": 0.0,
      "evidence": [],
      "notes": []
    },
    "vintage": {
      "value": null,
      "confidence": 0.0,
      "evidence": [],
      "notes": []
    },
    "wine_type": {
      "value": null,
      "confidence": 0.0,
      "evidence": [],
      "notes": []
    },
    "grape_varieties": {
      "value": [],
      "confidence": 0.0,
      "evidence": [],
      "notes": []
    },
    "country": {
      "value": null,
      "confidence": 0.0,
      "evidence": [],
      "notes": []
    },
    "region": {
      "value": null,
      "confidence": 0.0,
      "evidence": [],
      "notes": []
    },
    "appellation": {
      "value": null,
      "confidence": 0.0,
      "evidence": [],
      "notes": []
    },
    "classification": {
      "value": null,
      "confidence": 0.0,
      "evidence": [],
      "notes": []
    },
    "alcohol_abv": {
      "value": null,
      "confidence": 0.0,
      "evidence": [],
      "notes": []
    },
    "volume": {
      "value": null,
      "confidence": 0.0,
      "evidence": [],
      "notes": []
    },
    "bottler": {
      "value": null,
      "confidence": 0.0,
      "evidence": [],
      "notes": []
    },
    "importer": {
      "value": null,
      "confidence": 0.0,
      "evidence": [],
      "notes": []
    },
    "barcode": {
      "value": null,
      "confidence": 0.0,
      "evidence": [],
      "notes": []
    },
    "lot_code": {
      "value": null,
      "confidence": 0.0,
      "evidence": [],
      "notes": []
    },
    "allergens": {
      "value": [],
      "confidence": 0.0,
      "evidence": [],
      "notes": []
    },
    "other_visible_text": {
      "value": [],
      "confidence": 0.0,
      "evidence": [],
      "notes": []
    }
  },
  "overall_confidence": 0.0,
  "warnings": []
}
```

---

## Combiner prompts

### Combiner system prompt

```text
You are a wine-label extraction adjudicator.

You will receive two independent OCR/metadata extraction results for the same wine bottle:
1. Gemini extraction
2. Qwen extraction

Your task is to produce one canonical result by choosing the most likely correct value for each field.

Rules:
- Use only the supplied extractor outputs.
- Do not invent values not supported by at least one extractor.
- Prefer values with direct OCR evidence over unsupported normalized guesses.
- Prefer agreement between models.
- Where models disagree, choose the value with stronger evidence, higher confidence, and better consistency with wine-label conventions.
- Preserve accents and exact spelling for producer, cuvée, appellation, and label text.
- Use null when neither extraction provides adequate evidence.
- Record disagreements and the reason for the chosen value.
- Return only valid JSON matching the requested schema.
```

### Combiner user prompt

```text
Combine these two independent wine-label extraction results.

For each field:
- choose the best canonical value
- identify which model(s) support it
- copy supporting evidence
- assign final confidence
- record any disagreement or unresolved uncertainty

Gemini extraction:
{{GEMINI_EXTRACTION_JSON}}

Qwen extraction:
{{QWEN_EXTRACTION_JSON}}

Return only JSON.
```

---

## Combiner output format

```json
{
  "model_role": "combiner",
  "canonical_fields": {
    "producer": {
      "value": null,
      "confidence": 0.0,
      "supported_by": [],
      "evidence": [],
      "decision_reason": null
    },
    "brand": {
      "value": null,
      "confidence": 0.0,
      "supported_by": [],
      "evidence": [],
      "decision_reason": null
    },
    "wine_name_or_cuvee": {
      "value": null,
      "confidence": 0.0,
      "supported_by": [],
      "evidence": [],
      "decision_reason": null
    },
    "vintage": {
      "value": null,
      "confidence": 0.0,
      "supported_by": [],
      "evidence": [],
      "decision_reason": null
    },
    "grape_varieties": {
      "value": [],
      "confidence": 0.0,
      "supported_by": [],
      "evidence": [],
      "decision_reason": null
    },
    "wine_type": {
      "value": null,
      "confidence": 0.0,
      "supported_by": [],
      "evidence": [],
      "decision_reason": null
    },
    "country": {
      "value": null,
      "confidence": 0.0,
      "supported_by": [],
      "evidence": [],
      "decision_reason": null
    },
    "region": {
      "value": null,
      "confidence": 0.0,
      "supported_by": [],
      "evidence": [],
      "decision_reason": null
    },
    "appellation": {
      "value": null,
      "confidence": 0.0,
      "supported_by": [],
      "evidence": [],
      "decision_reason": null
    },
    "classification": {
      "value": null,
      "confidence": 0.0,
      "supported_by": [],
      "evidence": [],
      "decision_reason": null
    },
    "alcohol_abv": {
      "value": null,
      "confidence": 0.0,
      "supported_by": [],
      "evidence": [],
      "decision_reason": null
    },
    "volume": {
      "value": null,
      "confidence": 0.0,
      "supported_by": [],
      "evidence": [],
      "decision_reason": null
    },
    "barcode": {
      "value": null,
      "confidence": 0.0,
      "supported_by": [],
      "evidence": [],
      "decision_reason": null
    }
  },
  "canonical_label_text_lines": [],
  "field_disagreements": [
    {
      "field": "vintage",
      "gemini_value": null,
      "qwen_value": null,
      "chosen_value": null,
      "reason": null
    }
  ],
  "requires_human_review": false,
  "human_review_reasons": [],
  "overall_confidence": 0.0
}
```

---

## Model configuration

### Gemini extractor

OpenRouter lists `google/gemini-2.5-flash` as multimodal, with 1M context, structured output support, and configurable reasoning. ([OpenRouter][7])

```json
{
  "model": "google/gemini-2.5-flash",
  "temperature": 0,
  "top_p": 1,
  "max_tokens": 1600,
  "reasoning": {
    "effort": "minimal",
    "exclude": true
  },
  "provider": {
    "require_parameters": true
  },
  "response_format": {
    "type": "json_schema",
    "json_schema": {
      "name": "wine_label_extraction",
      "strict": true,
      "schema": {}
    }
  }
}
```

Tuning notes:

- Keep `temperature: 0`; OCR should not be creative.
- Use `reasoning.effort: minimal` for normal labels.
- Increase reasoning only if Gemini is used for hard labels, not for every extraction.
- Cap `max_tokens` tightly enough to prevent rambling but high enough for back labels.

---

### Qwen extractor

Use:

```json
{
  "model": "qwen/qwen3-vl-32b-instruct",
  "temperature": 0,
  "top_p": 1,
  "max_tokens": 1600,
  "provider": {
    "require_parameters": true
  },
  "response_format": {
    "type": "json_schema",
    "json_schema": {
      "name": "wine_label_extraction",
      "strict": true,
      "schema": {}
    }
  }
}
```

Tuning notes:

- Qwen should be the OCR-sensitive counterpart to Gemini.
- Do not use a “thinking” Qwen model for the first pass unless you find a measurable accuracy gain; it usually increases latency and output volume.
- If Qwen truncates raw OCR, raise `max_tokens` to 2200.
- If Qwen over-normalizes producer or appellation names, strengthen the prompt instruction: “preserve exact visible text; normalized fields must cite exact OCR evidence.”

---

### DeepSeek combiner

```json
{
  "model": "deepseek/deepseek-v4-flash",
  "temperature": 0,
  "top_p": 1,
  "max_tokens": 1400,
  "reasoning": {
    "effort": "high",
    "exclude": true
  },
  "provider": {
    "require_parameters": true
  },
  "response_format": {
    "type": "json_schema",
    "json_schema": {
      "name": "wine_label_canonical_result",
      "strict": true,
      "schema": {}
    }
  }
}
```

DeepSeek V4 Flash supports `high` and `xhigh` reasoning effort according to OpenRouter; use `high` for adjudication, not `xhigh`, unless the disagreement rate is material. ([OpenRouter][6])

Tuning notes:

- The combiner should not receive images at first. It should adjudicate text evidence.
- Use `temperature: 0`.
- Require explicit evidence and decision reason per field.
- Do not let it fill missing wine metadata from general knowledge. This is catalogue extraction, not wine enrichment.

---

## Request shape for the extraction calls

```json
{
  "model": "google/gemini-2.5-flash",
  "temperature": 0,
  "top_p": 1,
  "max_tokens": 1600,
  "messages": [
    {
      "role": "system",
      "content": "..."
    },
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "These images show the same wine bottle..."
        },
        {
          "type": "image_url",
          "image_url": {
            "url": "data:image/jpeg;base64,{{IMAGE_1_BASE64}}"
          }
        },
        {
          "type": "image_url",
          "image_url": {
            "url": "data:image/jpeg;base64,{{IMAGE_2_BASE64}}"
          }
        }
      ]
    }
  ],
  "provider": {
    "require_parameters": true
  },
  "response_format": {
    "type": "json_schema",
    "json_schema": {
      "name": "wine_label_extraction",
      "strict": true,
      "schema": {}
    }
  }
}
```

OpenRouter supports `response_format` with `json_schema`; its structured-output guidance recommends `require_parameters: true`, `response_format`, and `strict: true` for schema-constrained output. ([OpenRouter][8])

---

## Tuning guide

### Confidence thresholds

Use deterministic rules around the combiner output:

```text
auto_accept:
  overall_confidence >= 0.85
  and producer confidence >= 0.80
  and at least one of vintage / wine_name_or_cuvee / appellation has confidence >= 0.75
  and no critical disagreements

human_review:
  overall_confidence < 0.75
  or producer is null
  or vintage disagreement with both values plausible
  or appellation/region conflict
  or bottle_same_across_images is false
  or barcode conflicts
```

### Disagreement handling

Recommended field priority:

1. **Producer / wine name / cuvée**: prefer exact visible OCR evidence.
2. **Vintage**: prefer the value seen on the front label or neck label; do not infer from back-label copyright or importer dates.
3. **Appellation / region**: prefer formal designation text over inferred geography.
4. **Grape variety**: prefer explicit variety text; do not infer from appellation unless you later add a separate enrichment step.
5. **ABV / volume / barcode / lot code**: require exact text evidence.

### Prompt tuning

If outputs hallucinate:

```text
Add: “A missing value is better than a guessed value. Use null unless the value is directly supported by visible text.”
```

If outputs over-normalize:

```text
Add: “For names, preserve the spelling shown on the label. Put cleaned or normalized forms only in normalized fields.”
```

If multi-image results blend unrelated text:

```text
Add: “Process each image independently first. Do not merge lines across images until after raw_text_by_image is complete.”
```

If vintage is often wrong:

```text
Add: “Only treat a four-digit year as vintage if it appears as a prominent wine year or is near producer/cuvée/front-label text. Do not use copyright, establishment, import, website, or recycling dates as vintage.”
```

If back-label prose pollutes metadata:

```text
Add: “Back-label marketing prose belongs in other_visible_text unless it directly states a structured field.”
```

### Image tuning

Best 4-image set:

1. full front label;
2. close front label crop;
3. back label;
4. neck/capsule/barcode/ABV area.

Do not over-compress. Send images at a size where small ABV/barcode text remains legible. Prefer fixing image quality before raising model spend.

### Cost tuning

Run both extractors for now, but log outcomes. After 100–200 labelled bottles, measure:

- fields where Gemini wins;
- fields where Qwen wins;
- fields where both agree;
- combiner changes;
- human-review rate;
- cost per accepted bottle.

Then decide whether to:

- always run both;
- run Qwen first and Gemini only on low-confidence cases;
- run Gemini first and Qwen only on low-confidence cases;
- use both only for high-value bottles.

My expected outcome: **Qwen will likely be stronger on raw OCR**, while **Gemini may be stronger on general image understanding and structured interpretation**. The combiner should improve accuracy mainly by suppressing single-model hallucinations, not by discovering new text. Confidence: medium.

[1]: https://openrouter.ai/qwen "Qwen API and Models | OpenRouter"
[2]: https://developers.cloudflare.com/ai-gateway/usage/rest-api/?utm_source=chatgpt.com "REST API - AI Gateway"
[3]: https://developers.cloudflare.com/ai-gateway/usage/providers/openrouter/ "OpenRouter · Cloudflare AI Gateway docs"
[4]: https://developers.cloudflare.com/ai-gateway/reference/troubleshooting/?utm_source=chatgpt.com "Troubleshooting - AI Gateway"
[5]: https://openrouter.ai/docs/guides/overview/multimodal/image-understanding?utm_source=chatgpt.com "OpenRouter Image Inputs | Complete Documentation"
[6]: https://openrouter.ai/deepseek/deepseek-v4-flash "DeepSeek V4 Flash - API Pricing & Benchmarks | OpenRouter"
[7]: https://openrouter.ai/google/gemini-2.5-flash "Gemini 2.5 Flash - API Pricing & Benchmarks | OpenRouter"
[8]: https://openrouter.ai/docs/guides/features/structured-outputs?utm_source=chatgpt.com "Structured Outputs | Enforce JSON Schema in ..."
