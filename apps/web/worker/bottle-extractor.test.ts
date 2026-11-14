import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildCaptureImportCandidate } from "./bottle-extractor.ts";
import type { BottleExtractorResult } from "./bottle-ocr.ts";
import { importReviewedCapture } from "./bottle-importer.ts";
import { captureDatabaseFromEnv, createCaptureRun } from "./capture-store.ts";
import { asD1, migratedDatabase } from "./d1-support.ts";

type ExtractionOptions = {
  readonly alcoholValue?: string | null;
  readonly disagreements?: readonly string[];
  readonly displayNameConfidence?: number;
  readonly displayNameValue?: string | null;
  readonly grapeConfidence?: number;
  readonly humanReviewReasons?: readonly string[];
  readonly overallConfidence?: number;
  readonly requiresHumanReview?: boolean;
  readonly vintageConfidence?: number;
  readonly vintageValue?: string | null;
  readonly volumeValue?: string | null;
  readonly wineryConfidence?: number;
  readonly wineryValue?: string | null;
};

await describe("capture extraction draft", async () => {
  await it("retains high and low confidence as evidence without an import decision", () => {
    for (const overallConfidence of [0, 0.849, 0.85, 1]) {
      const result = draft({ overallConfidence });
      assert.equal("reviewDecision" in result, false);
      assert.equal(result.candidate.wine.wineryName, "Example Estate");
    }
  });

  await it("preserves an incomplete candidate for manual review instead of throwing", () => {
    const extracted = draft({ wineryValue: null });
    assert.equal(extracted.candidate.wine.wineryName, "");
  });

  await it("preserves structured grape names without splitting punctuation", () => {
    const extraction = extractorResult();
    extraction.fields.grapeVarieties.value = [
      "Cabernet Sauvignon",
      "Mataró / Monastrell",
      "Name & Name",
    ];
    const extracted = buildCaptureImportCandidate({
      extraction: { extractorId: "fixture", model: "fixture", result: extraction },
    });
    assert.deepEqual(
      extracted.candidate.wine.grapeVarieties,
      extraction.fields.grapeVarieties.value,
    );
  });

  await it("accepts a varietal wine without inventing a proprietary designation", () => {
    const result = draft({ displayNameValue: null });
    assert.equal(result.candidate.wine.designation, "");
    assert.deepEqual(result.candidate.wine.grapeVarieties, ["Shiraz"]);
  });

  await it("preserves explicit non-vintage separately from absent vintage evidence", () => {
    for (const vintage of ["NV", "N.V.", "non-vintage", null]) {
      const result = draft({ vintageValue: vintage });
      assert.equal(
        result.candidate.wine.vintageStatus,
        vintage === null ? "unknown" : "non_vintage",
      );
      assert.equal(result.candidate.wine.vintageYear, undefined);
    }
  });

  await it("retains warnings, every field/image note, and cross-image contradictions", () => {
    const result = extractorResult();
    result.warnings = ["Label is obscured."];
    result.bottle_same_across_images = false;
    result.fields.wineryName.notes = ["Uncertain producer"];
    result.raw_text_by_image = [{ image_index: 1, text: "Raw words", notes: ["Blurred"] }];
    result.canonical_label_text_lines = [];
    const extracted = buildCaptureImportCandidate({
      extraction: { extractorId: "fixture", model: "fixture", result },
    });
    assert.deepEqual(extracted.reviewReasons, [
      "Label is obscured.",
      "The images may show different bottles.",
      "wineryName: Uncertain producer",
      "Image 1: Blurred",
    ]);
    assert.equal(extracted.candidate.wine.labelText, "Raw words");
  });
});

await describe("capture label values at the inventory persistence seam", async () => {
  await it("normalizes metric units and unambiguous comma decimals before storing stock", async () => {
    for (const volume of ["75 cl", "0,75 L", "0.75 L", "750 mL", "75 centilitres"]) {
      const { sqlite, input } = await importSetup({ volumeValue: volume, alcoholValue: "14,5%" });
      try {
        assert.equal((await importReviewedCapture(input)).kind, "imported");
        assert.deepEqual(
          {
            ...sqlite
              .prepare(
                "SELECT b.volume_ml, w.alcohol_percent FROM bottles b JOIN wine_vintages w ON w.id = b.wine_vintage_id",
              )
              .get(),
          },
          { volume_ml: 750, alcohol_percent: 14.5 },
          volume,
        );
      } finally {
        sqlite.close();
      }
    }
  });

  await it("retains invalid or ambiguous label evidence and blocks confirmation until corrected", async () => {
    const examples: readonly ExtractionOptions[] = [
      ...[
        "1,500 L",
        "750 mL extra",
        "0 mL",
        "-750 mL",
        "750.5 mL",
        "0.0001 L",
        "31 L",
        "NaN mL",
        "Infinity L",
        "1e3 mL",
        "25 fl oz",
      ].map((volumeValue) => ({ volumeValue })),
      ...["101%", "-1%", "14.5-15%", "about 14.5%", "NaN%"].map((alcoholValue) => ({
        alcoholValue,
      })),
      { vintageValue: "2020/2021" },
      { vintageValue: "2201" },
    ];
    for (const example of examples) {
      const { sqlite, input } = await importSetup(example);
      try {
        assert.match(input.extracted.reviewReasons.join(" "), /wine\.|bottle\./u);
        await assert.rejects(importReviewedCapture(input));
        assert.equal(sqlite.prepare("SELECT count(*) AS count FROM bottles").get()?.["count"], 0);
        assert.equal(
          sqlite.prepare("SELECT count(*) AS count FROM wine_vintages").get()?.["count"],
          0,
        );
        assert.equal(
          sqlite.prepare("SELECT status FROM bottle_captures").get()?.["status"],
          "needs_review",
        );
        for (const raw of Object.values(example)) {
          assert.ok(JSON.stringify(input.candidate.rawSuggestion).includes(String(raw)));
        }
      } finally {
        sqlite.close();
      }
    }
  });

  await it("validates typed candidates again at deliberate confirmation", async () => {
    for (const volumeMl of [0, 30_001, 750.5, Infinity, Number.NaN]) {
      const { sqlite, input } = await importSetup();
      try {
        const invalid = { ...input, candidate: { ...input.candidate, bottle: { volumeMl } } };
        await assert.rejects(importReviewedCapture(invalid));
        assert.equal(sqlite.prepare("SELECT count(*) AS count FROM bottles").get()?.["count"], 0);
        assert.equal(
          sqlite.prepare("SELECT count(*) AS count FROM wine_vintages").get()?.["count"],
          0,
        );
      } finally {
        sqlite.close();
      }
    }
  });
});

async function importSetup(options: ExtractionOptions = {}) {
  const sqlite = migratedDatabase();
  sqlite.exec(
    "INSERT INTO users (id,clerk_user_id) VALUES ('user','user'); INSERT INTO sites (id,name) VALUES ('site','Cellar'); INSERT INTO site_memberships (site_id,user_id,role) VALUES ('site','user','owner'); INSERT INTO bottle_captures (id,site_id,user_id,status,workflow_instance_id) VALUES ('capture','site','user','extracting','capture')",
  );
  const database = captureDatabaseFromEnv(asD1(sqlite));
  await createCaptureRun({
    captureId: "capture",
    database,
    runId: "run_capture",
    workflowInstanceId: "capture",
  });
  sqlite.exec("UPDATE bottle_captures SET status = 'needs_review'");
  const extracted = draft(options);
  return {
    sqlite,
    input: {
      extracted,
      candidate: extracted.candidate,
      captureId: "capture",
      database,
      runId: "run_capture",
      workflowInstanceId: "capture",
      quantity: 1,
      siteId: "site",
      userId: "user",
      expectedReviewRevision: 0,
    },
  };
}

function draft(options: ExtractionOptions = {}) {
  return buildCaptureImportCandidate({
    extraction: { extractorId: "fixture", model: "fixture", result: extractorResult(options) },
  });
}

function extractorResult(options: ExtractionOptions = {}): BottleExtractorResult {
  return {
    model_role: "extractor",
    bottle_same_across_images: true,
    raw_text_by_image: [],
    fields: {
      wineryName: textField(
        "wineryValue" in options ? (options.wineryValue ?? null) : "Example Estate",
        options.wineryConfidence ?? 0.9,
      ),
      brandName: textField(null),
      displayName: textField(
        "displayNameValue" in options ? (options.displayNameValue ?? null) : "Reserve",
        options.displayNameConfidence ?? 0.9,
      ),
      vintage: textField(
        "vintageValue" in options ? (options.vintageValue ?? null) : "2020",
        options.vintageConfidence ?? 0.9,
      ),
      wineType: textField("red wine"),
      wineColor: textField("red"),
      grapeVarieties: {
        value: ["Shiraz"],
        confidence: options.grapeConfidence ?? 0.9,
        evidence: ["Shiraz"],
        notes: [],
      },
      country: textField("Australia"),
      region: textField("Barossa Valley"),
      appellation: textField(null),
      classification: textField(null),
      alcoholPercent: textField(
        "alcoholValue" in options ? (options.alcoholValue ?? null) : "14.5%",
      ),
      bottleVolumeMl: textField(
        "volumeValue" in options ? (options.volumeValue ?? null) : "750 mL",
      ),
      addressQualification: textField(null),
      barcode: textField(null),
      lotCode: textField(null),
      description: textField(null),
      drinkingAdvice: textField(null),
    },
    canonical_label_text_lines: ["Example Estate", "Reserve", "2020"],
    warnings: [],
    overall_confidence: options.overallConfidence ?? 0.9,
  };
}

function textField(value: string | null, confidence = 0.9) {
  return {
    value,
    confidence,
    evidence: value === null ? [] : [value],
    notes: [],
  };
}
