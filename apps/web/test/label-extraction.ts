import type { BottleExtractorResult } from "../worker/bottle-ocr.ts";

export function labelExtractionFixture(): BottleExtractorResult {
  return {
    model_role: "extractor",
    bottle_same_across_images: true,
    raw_text_by_image: [],
    fields: {
      wineryName: textField("Producer"),
      brandName: textField(null),
      displayName: textField("Reserve"),
      vintage: textField("2020"),
      wineType: textField(null),
      wineColor: textField(null),
      grapeVarieties: { ...textField(null), value: [] },
      country: textField(null),
      region: textField(null),
      appellation: textField(null),
      classification: textField(null),
      alcoholPercent: textField(null),
      bottleVolumeMl: textField(null),
      addressQualification: textField(null),
      barcode: textField(null),
      lotCode: textField(null),
      description: textField(null),
      drinkingAdvice: textField(null),
    },
    canonical_label_text_lines: ["Producer", "Reserve", "2020"],
    warnings: [],
    overall_confidence: 0.9,
  };
}

function textField(value: string | null) {
  return { value, confidence: 0.9, evidence: [], notes: [] };
}
