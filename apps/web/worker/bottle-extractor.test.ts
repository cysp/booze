import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildCaptureImportCandidate, decideCaptureImport } from "./bottle-extractor.ts";
import type { BottleCombinedExtraction } from "./bottle-ocr.ts";
import { importBottleCandidate, importReviewedCapture } from "./bottle-importer.ts";
import { captureDatabaseFromEnv, createCaptureRun } from "./capture-store.ts";
import { asD1, migratedDatabase } from "./d1-support.ts";

type CombinedOptions = {
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

await describe("capture OCR import review decision", async () => {
  await it("auto-imports only when every threshold is met", () => {
    assert.deepEqual(
      decideCaptureImport({
        combined: combinedExtraction({
          overallConfidence: 0.85,
          vintageConfidence: 0.75,
          wineryConfidence: 0.8,
        }),
        extractors: {},
      }),
      { kind: "auto_import", reasons: [] },
    );
  });

  await it("requires review below the overall-confidence threshold", () => {
    const decision = decideCaptureImport({
      combined: combinedExtraction({ overallConfidence: 0.849 }),
      extractors: {},
    });
    assert.equal(decision.kind, "needs_review");
    assert.match(decision.reasons.join(" "), /Overall OCR confidence/u);
  });

  await it("requires review for missing or low-confidence producer identity", () => {
    for (const options of [
      { wineryValue: null },
      { wineryConfidence: 0.799 },
    ] satisfies readonly CombinedOptions[]) {
      assert.equal(
        decideCaptureImport({
          combined: combinedExtraction(options),
          extractors: {},
        }).kind,
        "needs_review",
      );
    }
  });

  await it("preserves an incomplete candidate for manual review instead of throwing", () => {
    const extracted = buildCaptureImportCandidate({
      combined: combinedExtraction({ wineryValue: null }),
      extractors: {},
    });
    assert.equal(extracted.reviewDecision.kind, "needs_review");
    assert.equal(extracted.candidate.wine.wineryName, "");
  });

  await it("requires a confident descriptor rather than a vintage alone", () => {
    const decision = decideCaptureImport({
      combined: combinedExtraction({
        displayNameConfidence: 0.74,
        grapeConfidence: 0.74,
        vintageConfidence: 0.74,
        vintageValue: "2020",
      }),
      extractors: {},
    });
    assert.equal(decision.kind, "needs_review");
    assert.match(decision.reasons.join(" "), /No grape variety, wine designation/u);
  });

  await it("accepts a confident varietal wine without a proprietary designation", () => {
    const result = buildCaptureImportCandidate({
      combined: combinedExtraction({ displayNameValue: null }),
      extractors: {},
    });
    assert.equal(result.reviewDecision.kind, "auto_import");
    assert.equal(result.candidate.wine.designation, "");
    assert.deepEqual(result.candidate.wine.grapeVarieties, ["Shiraz"]);
  });

  await it("preserves explicit non-vintage separately from absent vintage evidence", () => {
    for (const vintage of ["NV", "N.V.", "non-vintage", null]) {
      const result = buildCaptureImportCandidate({
        combined: combinedExtraction({ vintageValue: vintage }),
        extractors: {},
      });
      assert.equal(
        result.candidate.wine.vintageStatus,
        vintage === null ? "unknown" : "non_vintage",
      );
      assert.equal(result.candidate.wine.vintageYear, undefined);
    }
  });

  await it("honours combiner review flags, reasons, and disagreements", () => {
    for (const options of [
      { requiresHumanReview: true },
      { humanReviewReasons: ["Label is obscured."] },
      { disagreements: ["vintage differs between extractors"] },
    ] satisfies readonly CombinedOptions[]) {
      assert.equal(
        decideCaptureImport({
          combined: combinedExtraction(options),
          extractors: {},
        }).kind,
        "needs_review",
      );
    }
  });

  await it("requires review when any extractor sees different bottles", () => {
    const decision = decideCaptureImport({
      combined: combinedExtraction(),
      extractors: {
        first: { bottle_same_across_images: true },
        second: { bottle_same_across_images: false },
      },
    });
    assert.equal(decision.kind, "needs_review");
    assert.match(decision.reasons.join(" "), /different bottles/u);
  });
});

await describe("capture label values at the inventory persistence seam", async () => {
  await it("normalizes metric units and unambiguous comma decimals before storing stock", async () => {
    for (const volume of ["75 cl", "0,75 L", "0.75 L", "750 mL", "75 centilitres"]) {
      const { sqlite, input } = await importSetup({ volumeValue: volume, alcoholValue: "14,5%" });
      try {
        assert.equal(input.extracted.reviewDecision.kind, "auto_import");
        assert.equal((await importBottleCandidate(input)).kind, "imported");
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

  await it("retains invalid or ambiguous label evidence for review and blocks automatic stock changes", async () => {
    const examples: readonly CombinedOptions[] = [
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
        assert.equal(input.extracted.reviewDecision.kind, "needs_review", JSON.stringify(example));
        assert.match(input.extracted.reviewDecision.reasons.join(" "), /wine\.|bottle\./u);
        assert.equal(
          (await importBottleCandidate(input)).kind,
          "needs_review",
          JSON.stringify(example),
        );
        assert.equal(sqlite.prepare("SELECT count(*) AS count FROM bottles").get()?.["count"], 0);
        assert.equal(
          sqlite.prepare("SELECT count(*) AS count FROM wine_vintages").get()?.["count"],
          0,
        );
        assert.equal(
          sqlite.prepare("SELECT status FROM bottle_captures").get()?.["status"],
          "extracting",
        );
        for (const raw of Object.values(example)) {
          assert.ok(JSON.stringify(input.candidate.rawSuggestion).includes(String(raw)));
        }
      } finally {
        sqlite.close();
      }
    }
  });

  await it("validates typed candidates again for direct automatic and reviewed import callers", async () => {
    for (const volumeMl of [0, 30_001, 750.5, Infinity, Number.NaN]) {
      for (const reviewed of [false, true]) {
        const { sqlite, input } = await importSetup();
        try {
          const invalid = { ...input, candidate: { ...input.candidate, bottle: { volumeMl } } };
          if (reviewed) {
            sqlite.exec("UPDATE bottle_captures SET status = 'needs_review'");
            await assert.rejects(importReviewedCapture({ ...invalid, expectedReviewRevision: 0 }));
          } else {
            const result = await importBottleCandidate(invalid);
            assert.equal(result.kind, "needs_review");
            assert.equal(result.reason, "invalid_candidate");
          }
          assert.equal(sqlite.prepare("SELECT count(*) AS count FROM bottles").get()?.["count"], 0);
          assert.equal(
            sqlite.prepare("SELECT count(*) AS count FROM wine_vintages").get()?.["count"],
            0,
          );
        } finally {
          sqlite.close();
        }
      }
    }
  });
});

async function importSetup(options: CombinedOptions = {}) {
  const sqlite = migratedDatabase();
  sqlite.exec(
    "INSERT INTO users (id,clerk_user_id) VALUES ('user','user'); INSERT INTO sites (id,name) VALUES ('site','Cellar'); INSERT INTO bottle_captures (id,site_id,user_id,status,workflow_instance_id) VALUES ('capture','site','user','extracting','capture')",
  );
  const database = captureDatabaseFromEnv(asD1(sqlite));
  await createCaptureRun({
    captureId: "capture",
    database,
    runId: "run_capture",
    status: "extracting",
  });
  const extracted = buildCaptureImportCandidate({
    combined: combinedExtraction(options),
    extractors: {},
  });
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
    },
  };
}

function combinedExtraction(options: CombinedOptions = {}): BottleCombinedExtraction {
  return {
    model_role: "combiner",
    canonical_fields: {
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
        supported_by: ["first", "second"],
        evidence: ["Shiraz"],
        decision_reason: null,
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
    field_disagreements: [...(options.disagreements ?? [])],
    requires_human_review: options.requiresHumanReview ?? false,
    human_review_reasons: [...(options.humanReviewReasons ?? [])],
    overall_confidence: options.overallConfidence ?? 0.9,
  };
}

function textField(value: string | null, confidence = 0.9) {
  return {
    value,
    confidence,
    supported_by: ["first", "second"],
    evidence: value === null ? [] : [value],
    decision_reason: null,
  };
}
