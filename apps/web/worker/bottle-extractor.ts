import {
  catalogueCandidateSchema,
  type BottleInput,
  type CandidateValidationIssue,
  type WineInput,
} from "../shared/catalogue-inputs.ts";
import {
  BottleOcrError,
  combineBottleLabelEvidence,
  defaultBottleCombinerConfig,
  defaultBottleExtractorConfigs,
  extractBottleLabelEvidenceWithExtractor,
  suggestionFromBottleCombination,
  type BottleCombinedExtraction,
  type BottleExtractorConfig,
  type BottleExtractorResult,
  type BottleExtractorsResult,
  type BottleOcrImageContent,
  type BottleOcrDiagnostic,
  type BottleOcrSuggestion,
} from "./bottle-ocr.ts";
import type { CaptureWorkflowRecord } from "./capture-store.ts";

export type ImportCandidate = {
  readonly wine: WineInput;
  readonly bottle: BottleInput;
  readonly rawSuggestion: unknown;
  readonly validationIssues?: readonly CandidateValidationIssue[] | undefined;
};

export type CaptureImportReviewDecision =
  | {
      readonly kind: "auto_import";
      readonly reasons: readonly [];
    }
  | {
      readonly kind: "needs_review";
      readonly reason: "ocr_human_review_required";
      readonly reasons: readonly string[];
    };

export type CaptureExtractorResult = {
  readonly diagnostics: readonly BottleOcrDiagnostic[];
  readonly extractorId: string;
  readonly model: string;
  readonly result: BottleExtractorResult;
};

export type CaptureReconciliationResult = {
  readonly combined: BottleCombinedExtraction;
  readonly diagnostics: readonly BottleOcrDiagnostic[];
  readonly model: string;
};

export async function extractCaptureLabelEvidence({
  bucket,
  capture,
  diagnostics,
  extractor,
  gatewayToken,
  gatewayUrl,
  images,
}: {
  readonly bucket: R2Bucket;
  readonly capture: CaptureWorkflowRecord;
  readonly diagnostics?: BottleOcrDiagnostic[] | undefined;
  readonly extractor: BottleExtractorConfig;
  readonly gatewayToken: string | undefined;
  readonly gatewayUrl: string | undefined;
  readonly images?: ImagesBinding | undefined;
}): Promise<Omit<CaptureExtractorResult, "diagnostics">> {
  const extracted = await extractBottleLabelEvidenceWithExtractor({
    diagnostics,
    extractor,
    gatewayToken,
    ...(gatewayUrl === undefined ? {} : { gatewayUrl }),
    imageContent: await captureImageContent({ bucket, capture, images }),
  });
  return {
    extractorId: extracted.extractorId,
    model: extracted.model,
    result: extracted.result,
  };
}

export async function reconcileCaptureLabelEvidence({
  diagnostics,
  extractors,
  gatewayToken,
  gatewayUrl,
}: {
  readonly diagnostics?: BottleOcrDiagnostic[] | undefined;
  readonly extractors: BottleExtractorsResult;
  readonly gatewayToken: string | undefined;
  readonly gatewayUrl: string | undefined;
}): Promise<Omit<CaptureReconciliationResult, "diagnostics">> {
  const combiner = defaultBottleCombinerConfig({
    gatewayToken,
    ...(gatewayUrl === undefined ? {} : { gatewayUrl }),
  });
  return {
    combined: await combineBottleLabelEvidence({
      combiner,
      diagnostics,
      extractors,
    }),
    model: combiner.model,
  };
}

export function extractorsFromCaptureResults(
  results: readonly Pick<CaptureExtractorResult, "extractorId" | "result">[],
): BottleExtractorsResult {
  return Object.fromEntries(results.map((result) => [result.extractorId, result.result]));
}

export function buildCaptureImportCandidate({
  combined,
  extractors,
}: {
  readonly combined: BottleCombinedExtraction;
  readonly extractors: BottleExtractorsResult;
}): {
  readonly candidate: ImportCandidate;
  readonly imageText: unknown;
  readonly model: string;
  readonly reviewDecision: CaptureImportReviewDecision;
} {
  const suggestion = suggestionFromBottleCombination({ combined, extractors });
  const candidate = candidateFromSuggestion(suggestion, combined.canonical_fields.vintage.value);
  const decision = decideCaptureImport({ combined, extractors });
  const reasons = [
    ...decision.reasons,
    ...(candidate.validationIssues ?? []).map(
      (issue) => `${issue.path}: ${issue.message} Label value: ${JSON.stringify(issue.rawValue)}.`,
    ),
  ];
  return {
    candidate,
    imageText: suggestion.structuredExtraction ?? suggestion,
    model: "multi-extractor-combiner",
    reviewDecision:
      reasons.length === 0
        ? { kind: "auto_import", reasons: [] }
        : { kind: "needs_review", reason: "ocr_human_review_required", reasons },
  };
}

export { defaultBottleExtractorConfigs };

export function decideCaptureImport({
  combined,
  extractors,
}: {
  readonly combined: BottleCombinedExtraction;
  readonly extractors: Readonly<
    Record<string, Pick<BottleExtractorResult, "bottle_same_across_images">>
  >;
}): CaptureImportReviewDecision {
  const reasons = [...combined.human_review_reasons];
  if (combined.requires_human_review && reasons.length === 0) {
    reasons.push("The reconciliation model requested human review.");
  }
  if (combined.overall_confidence < 0.85) {
    reasons.push(
      `Overall OCR confidence is ${combined.overall_confidence}; at least 0.85 is required.`,
    );
  }

  const winery = combined.canonical_fields.wineryName;
  if (winery.value === null || winery.value.trim() === "") {
    reasons.push("The producer or winery is missing.");
  } else if (winery.confidence < 0.8) {
    reasons.push(`Producer confidence is ${winery.confidence}; at least 0.8 is required.`);
  }

  const identityFields = [
    combined.canonical_fields.displayName,
    combined.canonical_fields.appellation,
  ];
  if (
    !(
      combined.canonical_fields.grapeVarieties.value.length > 0 &&
      combined.canonical_fields.grapeVarieties.confidence >= 0.75
    ) &&
    !identityFields.some(
      (field) => field.value !== null && field.value.trim() !== "" && field.confidence >= 0.75,
    )
  ) {
    reasons.push(
      "No grape variety, wine designation, or appellation has confidence of at least 0.75.",
    );
  }

  reasons.push(
    ...combined.field_disagreements.map((disagreement) => `Field disagreement: ${disagreement}`),
    ...Object.entries(extractors)
      .filter(([, extractor]) => !extractor.bottle_same_across_images)
      .map(([extractorId]) => `${extractorId} found that the images may show different bottles.`),
  );

  const uniqueReasons = [...new Set(reasons.map((reason) => reason.trim()).filter(Boolean))];
  return uniqueReasons.length === 0
    ? { kind: "auto_import", reasons: [] }
    : {
        kind: "needs_review",
        reason: "ocr_human_review_required",
        reasons: uniqueReasons,
      };
}

export async function captureImageContent({
  bucket,
  capture,
  images,
}: {
  readonly bucket: R2Bucket;
  readonly capture: CaptureWorkflowRecord;
  readonly images?: ImagesBinding | undefined;
}): Promise<readonly BottleOcrImageContent[]> {
  const content: BottleOcrImageContent[] = [];
  for (const image of capture.images) {
    const object = await bucket.get(image.r2Key);
    if (object === null) {
      throw new BottleOcrError(503, `Stored image ${image.imageAssetId} is missing`);
    }
    content.push({
      type: "image_url",
      image_url: {
        url: await objectToDataUrl({
          contentType: image.contentType,
          images,
          object,
        }),
      },
    });
  }
  return content;
}

function candidateFromSuggestion(
  suggestion: BottleOcrSuggestion,
  vintageLabel: string | null,
): ImportCandidate {
  const validationIssues: CandidateValidationIssue[] = [];
  const wineryName = text(suggestion.wineryName) ?? "";
  const displayName = text(suggestion.displayName) ?? "";
  const vintageYear = normalizedNumber(
    vintageLabel,
    "wine.vintageYear",
    validationIssues,
    parseYear,
  );
  const candidate: ImportCandidate = {
    wine: {
      wineryName,
      brandName: text(suggestion.brandName) ?? undefined,
      baseName: displayName,
      designation: displayName,
      displayName,
      vintageYear,
      vintageStatus:
        vintageYear === undefined
          ? isNonVintage(vintageLabel)
            ? "non_vintage"
            : "unknown"
          : "year",
      grapeVarieties: grapeVarietiesFromText(suggestion.grapeVarieties),
      country: text(suggestion.country) ?? "",
      region: text(suggestion.region) ?? "",
      appellation: text(suggestion.appellation) ?? "",
      classification: text(suggestion.classification) ?? "",
      wineType: text(suggestion.wineType) ?? "",
      wineColor: text(suggestion.wineColor) ?? "",
      addressQualification: text(suggestion.addressQualification) ?? "",
      alcoholPercent: normalizedNumber(
        suggestion.alcoholPercent,
        "wine.alcoholPercent",
        validationIssues,
        parseAlcoholPercent,
      ),
      drinkFromYear: normalizedNumber(
        suggestion.drinkFromYear,
        "wine.drinkFromYear",
        validationIssues,
        parseYear,
      ),
      drinkToYear: normalizedNumber(
        suggestion.drinkToYear,
        "wine.drinkToYear",
        validationIssues,
        parseYear,
      ),
      description: text(suggestion.description) ?? "",
      drinkingAdvice: text(suggestion.drinkingAdvice) ?? "",
      labelText: text(suggestion.labelText) ?? "",
      sourceUrl: text(suggestion.sourceUrl) ?? "",
      notes: text(suggestion.wineNotes) ?? "",
    },
    bottle: {
      volumeMl: normalizedNumber(
        suggestion.bottleVolumeMl,
        "bottle.volumeMl",
        validationIssues,
        parseVolumeMl,
      ),
      barcode: text(suggestion.barcode) ?? "",
      lotCode: text(suggestion.lotCode) ?? "",
    },
    rawSuggestion: suggestion,
  };
  return validateNormalizedCandidate(candidate, validationIssues);
}

function validateNormalizedCandidate(
  candidate: ImportCandidate,
  validationIssues: CandidateValidationIssue[],
): ImportCandidate {
  const validated = catalogueCandidateSchema.safeParse(candidate);
  if (!validated.success) {
    validationIssues.push(
      ...validated.error.issues.map((issue) => ({
        path: issue.path.join("."),
        rawValue: JSON.stringify(issue.path[0] === "bottle" ? candidate.bottle : candidate.wine),
        message: issue.message,
      })),
    );
  }
  return {
    ...candidate,
    ...(validated.success ? validated.data : {}),
    ...(validationIssues.length === 0 ? {} : { validationIssues }),
  };
}

async function objectToDataUrl({
  contentType,
  images,
  object,
}: {
  readonly contentType: string;
  readonly images: ImagesBinding | undefined;
  readonly object: R2ObjectBody;
}): Promise<string> {
  const maxInferenceImageBytes = 2 * 1024 * 1024;
  // oxlint-disable-next-line typescript/no-unsafe-assignment -- R2 guarantees bytes; its declaration leaves the stream chunk type as any.
  const body: ReadableStream<Uint8Array> = object.body;
  if (images === undefined) {
    const bytes = await readImageBytes(body, maxInferenceImageBytes);
    return `data:${contentType};base64,${bytesToBase64(bytes)}`;
  }
  const result = await images
    .input(body)
    .transform({ width: 2048, height: 2048, fit: "scale-down" })
    .output({ format: "image/jpeg", quality: 80 });
  const bytes = await readImageBytes(result.image(), maxInferenceImageBytes);
  return `data:${result.contentType()};base64,${bytesToBase64(bytes)}`;
}

async function readImageBytes(
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new Error(
          "Image is too large for label extraction; the original photo remains saved.",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCodePoint(...chunk);
  }
  return btoa(binary);
}

function text(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function isNonVintage(value: string | null): boolean {
  return value !== null && /^(?:n[.\s]?v[.]?|non[ -]?vintage)$/iu.test(value.trim());
}

function normalizedNumber(
  value: string | null | undefined,
  path: string,
  issues: CandidateValidationIssue[],
  parse: (value: string) => number | undefined,
): number | undefined {
  if (value === undefined || value === null || value.trim() === "") return undefined;
  if (path === "wine.vintageYear" && isNonVintage(value)) return undefined;
  const normalized = parse(value.trim());
  if (normalized === undefined) {
    issues.push({
      path,
      rawValue: value,
      message:
        path === "bottle.volumeMl"
          ? "Enter an unambiguous metric volume in mL, cL, or L, with a whole number of millilitres between 1 and 30000."
          : path === "wine.alcoholPercent"
            ? "Enter an unambiguous alcohol percentage between 0 and 100."
            : "Enter one complete year between 1800 and 2200, or an explicit non-vintage label.",
    });
  }
  return normalized;
}

function parseYear(value: string): number | undefined {
  return /^(?:18|19|20|21)\d{2}$|^2200$/u.test(value) ? Number(value) : undefined;
}

function decimalRatio(
  value: string,
): { readonly numerator: bigint; readonly denominator: bigint } | undefined {
  const match = /^(\d+)(?:[.,](\d+))?$/u.exec(value);
  const whole = match?.[1];
  if (whole === undefined) return undefined;
  const fraction = match?.[2] ?? "";
  // A three-digit suffix after a nonzero integer may be a grouping separator.
  if (fraction.length === 3 && !/^0+$/u.test(whole)) return undefined;
  return { numerator: BigInt(`${whole}${fraction}`), denominator: 10n ** BigInt(fraction.length) };
}

function parseAlcoholPercent(value: string): number | undefined {
  const match = /^(\d+(?:[.,]\d+)?)\s*(?:%\s*(?:vol\.?|abv)?)?$/iu.exec(value);
  const ratio = match?.[1] === undefined ? undefined : decimalRatio(match[1]);
  if (ratio === undefined) return undefined;
  const percent = Number(ratio.numerator) / Number(ratio.denominator);
  return Number.isFinite(percent) && percent >= 0 && percent <= 100 ? percent : undefined;
}

function parseVolumeMl(value: string): number | undefined {
  const match =
    /^(\d+(?:[.,]\d+)?)\s*(ml|cl|l|millilit(?:re|er)s?|centilit(?:re|er)s?|lit(?:re|er)s?)$/iu.exec(
      value,
    );
  const ratio = match?.[1] === undefined ? undefined : decimalRatio(match[1]);
  const unit = match?.[2]?.toLowerCase();
  if (ratio === undefined || unit === undefined) return undefined;
  const multiplier =
    unit === "ml" || unit.startsWith("milli")
      ? 1n
      : unit === "cl" || unit.startsWith("centi")
        ? 10n
        : 1000n;
  const scaled = ratio.numerator * multiplier;
  if (scaled % ratio.denominator !== 0n) return undefined;
  const volume = scaled / ratio.denominator;
  return volume >= 1n && volume <= 30_000n ? Number(volume) : undefined;
}

function grapeVarietiesFromText(value: string | undefined): readonly string[] {
  return (
    value
      ?.split(/[,;/+&]/u)
      .map((grape) => grape.trim())
      .filter((grape) => grape !== "") ?? []
  );
}
