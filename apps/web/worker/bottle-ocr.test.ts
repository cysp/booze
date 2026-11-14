import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";

import {
  BottleOcrError,
  defaultBottleExtractorConfig,
  extractBottleLabelEvidence,
} from "./bottle-ocr.ts";

const textFields = [
  "brandName",
  "displayName",
  "vintage",
  "wineType",
  "wineColor",
  "country",
  "region",
  "appellation",
  "classification",
  "alcoholPercent",
  "bottleVolumeMl",
  "addressQualification",
  "barcode",
  "lotCode",
  "description",
  "drinkingAdvice",
];

function extraction() {
  return {
    model_role: "extractor",
    bottle_same_across_images: true,
    raw_text_by_image: [
      { image_index: 1, text: "Front label", notes: [] as unknown[] },
      { image_index: 2, text: "Back label", notes: [] as unknown[] },
    ],
    canonical_label_text_lines: ["Front label", "Back label"],
    fields: {
      ...Object.fromEntries(
        textFields.map((field) => [
          field,
          {
            value: null,
            confidence: 0,
            evidence: [],
            notes: [] as unknown[],
          },
        ]),
      ),
      wineryName: { value: null, confidence: 0, evidence: [], notes: [] as unknown[] },
      grapeVarieties: { value: [], confidence: 0, evidence: [], notes: [] as unknown[] },
    },
    overall_confidence: 0,
    warnings: [],
  };
}

await describe("OCR extractor response validation", async () => {
  await it("makes one configured request and retains raw provider response and matching schema constraints", async (t) => {
    const payload = extraction();
    const rawResponse = {
      provider: "fixture-provider",
      id: "fixture-request",
      choices: [{ message: { content: JSON.stringify(payload) } }],
    };
    let requests = 0;
    t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
      requests += 1;
      assert.equal(typeof init?.body, "string");
      assert.ok(typeof init?.body === "string");
      const request = z
        .object({
          model: z.string(),
          max_tokens: z.number(),
          temperature: z.number(),
          provider: z.object({ require_parameters: z.literal(true) }),
          response_format: z.object({
            type: z.literal("json_schema"),
            json_schema: z.object({
              strict: z.literal(true),
              schema: z.record(z.string(), z.unknown()),
            }),
          }),
        })
        .parse(JSON.parse(init.body));
      assert.equal(request.model, "google/gemini-3-flash-preview");
      assert.equal(request.max_tokens, 6_000);
      assert.equal(request.temperature, 0);
      const schema = request.response_format.json_schema.schema;
      assert.equal("$schema" in schema, false);
      const properties = z.record(z.string(), z.unknown()).parse(schema["properties"]);
      assert.deepEqual(properties["model_role"], { type: "string", enum: ["extractor"] });
      const fields = z
        .object({ properties: z.record(z.string(), z.unknown()) })
        .parse(properties["fields"]).properties;
      const winery = z
        .object({
          properties: z.record(z.string(), z.unknown()),
          additionalProperties: z.literal(false),
          required: z.array(z.string()),
        })
        .parse(fields["wineryName"]);
      assert.deepEqual(winery.properties["value"], { type: ["string", "null"] });
      assert.deepEqual(winery.properties["confidence"], { type: "number", minimum: 0, maximum: 1 });
      assert.deepEqual(winery.properties["notes"], { type: "array", items: { type: "string" } });
      // Validate the mock provider payload through the wire schema as well as
      // the production response parser, without making a hosted model call.
      assert.equal(z.fromJSONSchema(schema).safeParse(payload).success, true);
      assert.equal(
        z.fromJSONSchema(schema).safeParse({ ...payload, overall_confidence: 1.1 }).success,
        false,
      );
      return Response.json(rawResponse);
    });
    const result = await extractBottleLabelEvidence({
      gatewayToken: "test-token",
      gatewayUrl: "https://ocr.invalid/chat/completions",
      imageContent: [],
    });
    assert.equal(requests, 1);
    assert.deepEqual(result.configuration, defaultBottleExtractorConfig);
    assert.equal(result.rawResponse, JSON.stringify(rawResponse));
  });

  await it("preserves nine notes on the second image instead of failing the capture", async (t) => {
    const payload = extraction();
    const notes = Array.from({ length: 9 }, (_, i) => `Observation ${i + 1}`);
    const secondImage = payload.raw_text_by_image[1];
    assert.ok(secondImage);
    secondImage.notes = notes;
    t.mock.method(globalThis, "fetch", async () =>
      Response.json({
        choices: [{ message: { content: JSON.stringify(payload) } }],
      }),
    );

    const { result } = await extractBottleLabelEvidence({
      gatewayToken: "test-token",
      gatewayUrl: "https://ocr.invalid/chat/completions",
      imageContent: [],
    });
    assert.deepEqual(result.raw_text_by_image[1]?.notes, notes);
  });
  await it("preserves field notes beyond the old local limit", async (t) => {
    const payload = extraction();
    const notes = Array.from({ length: 17 }, (_, i) => `Uncertainty ${i + 1}`);
    payload.fields.wineryName.notes = notes;
    payload.fields.grapeVarieties.notes = notes;
    t.mock.method(globalThis, "fetch", async () =>
      Response.json({
        choices: [{ message: { content: JSON.stringify(payload) } }],
      }),
    );
    const { result } = await extractBottleLabelEvidence({
      gatewayToken: "test-token",
      gatewayUrl: "https://ocr.invalid/chat/completions",
      imageContent: [],
    });
    assert.deepEqual(result.fields.wineryName.notes, notes);
    assert.deepEqual(result.fields.grapeVarieties.notes, notes);
  });

  await it("still rejects non-text notes and invalid confidence", async (t) => {
    for (const malformed of ["notes", "confidence"]) {
      const payload = extraction();
      const image = payload.raw_text_by_image[1];
      assert.ok(image);
      if (malformed === "notes") image.notes = [42];
      else payload.overall_confidence = 1.1;
      t.mock.method(globalThis, "fetch", async () =>
        Response.json({
          choices: [{ message: { content: JSON.stringify(payload) } }],
        }),
      );
      await assert.rejects(
        extractBottleLabelEvidence({
          gatewayToken: "test-token",
          gatewayUrl: "https://ocr.invalid/chat/completions",
          imageContent: [],
        }),
        (error: unknown) =>
          error instanceof BottleOcrError &&
          error.status === 502 &&
          error.message.includes(
            malformed === "notes" ? "raw_text_by_image.1.notes.0" : "overall_confidence",
          ),
      );
      t.mock.restoreAll();
    }
  });
});
