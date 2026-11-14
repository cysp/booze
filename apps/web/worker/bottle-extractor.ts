import {
  catalogueCandidateSchema,
  type BottleInput,
  type CandidateValidationIssue,
  type WineInput,
} from "../shared/catalogue-inputs.ts";
import {
  BottleOcrError,
  extractBottleLabelEvidence,
  type BottleExtractorResult,
  type BottleExtractorStepResult,
  type BottleOcrImageContent,
  type BottleOcrDiagnostic,
} from "./bottle-ocr.ts";
import type { CaptureWorkflowRecord } from "./capture-store.ts";

export type ImportCandidate = {
  readonly wine: WineInput;
  readonly bottle: BottleInput;
  readonly rawSuggestion: unknown;
  readonly validationIssues?: readonly CandidateValidationIssue[] | undefined;
};

export type CaptureExtractorResult = BottleExtractorStepResult & {
  readonly diagnostics: readonly BottleOcrDiagnostic[];
};

export async function extractCaptureLabelEvidence({
  bucket,
  capture,
  diagnostics,
  gatewayToken,
  gatewayUrl,
  images,
}: {
  readonly bucket: R2Bucket;
  readonly capture: CaptureWorkflowRecord;
  readonly diagnostics?: BottleOcrDiagnostic[] | undefined;
  readonly gatewayToken: string | undefined;
  readonly gatewayUrl: string | undefined;
  readonly images?: ImagesBinding | undefined;
}): Promise<BottleExtractorStepResult> {
  return extractBottleLabelEvidence({
    diagnostics,
    gatewayToken,
    ...(gatewayUrl === undefined ? {} : { gatewayUrl }),
    imageContent: await captureImageContent({ bucket, capture, images }),
  });
}

export function buildCaptureImportCandidate({
  extraction,
}: {
  readonly extraction: Pick<CaptureExtractorResult, "extractorId" | "model" | "result">;
}): { readonly candidate: ImportCandidate; readonly reviewReasons: readonly string[] } {
  const { result } = extraction;
  const fields = result.fields;
  const validationIssues: CandidateValidationIssue[] = [];
  const vintageLabel = fields.vintage.value;
  const vintageYear = normalizedNumber(
    vintageLabel,
    "wine.vintageYear",
    validationIssues,
    parseYear,
  );
  const displayName = text(fields.displayName.value);
  const candidate = validateNormalizedCandidate(
    {
      wine: {
        wineryName: text(fields.wineryName.value),
        brandName: text(fields.brandName.value) || undefined,
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
        // The model returns a structured list. Punctuation can be part of a grape name.
        grapeVarieties: fields.grapeVarieties.value.map((value) => value.trim()).filter(Boolean),
        country: text(fields.country.value),
        region: text(fields.region.value),
        appellation: text(fields.appellation.value),
        classification: text(fields.classification.value),
        wineType: text(fields.wineType.value),
        wineColor: text(fields.wineColor.value),
        addressQualification: text(fields.addressQualification.value),
        alcoholPercent: normalizedNumber(
          fields.alcoholPercent.value,
          "wine.alcoholPercent",
          validationIssues,
          parseAlcoholPercent,
        ),
        description: text(fields.description.value),
        drinkingAdvice: text(fields.drinkingAdvice.value),
        labelText: labelText(result),
        notes: "",
      },
      bottle: {
        volumeMl: normalizedNumber(
          fields.bottleVolumeMl.value,
          "bottle.volumeMl",
          validationIssues,
          parseVolumeMl,
        ),
        barcode: text(fields.barcode.value),
        lotCode: text(fields.lotCode.value),
      },
      rawSuggestion: {
        extractorId: extraction.extractorId,
        model: extraction.model,
        alcoholPercent: fields.alcoholPercent.value,
        bottleVolumeMl: fields.bottleVolumeMl.value,
        vintageYear: vintageLabel,
        extraction: result,
      },
    },
    validationIssues,
  );
  const reviewReasons = [
    ...result.warnings,
    ...(result.bottle_same_across_images ? [] : ["The images may show different bottles."]),
    ...Object.entries(fields).flatMap(([name, field]) =>
      field.notes.map((note) => `${name}: ${note}`),
    ),
    ...result.raw_text_by_image.flatMap((image) =>
      image.notes.map((note) => `Image ${image.image_index}: ${note}`),
    ),
    ...(candidate.validationIssues ?? []).map(
      (issue) => `${issue.path}: ${issue.message} Label value: ${JSON.stringify(issue.rawValue)}.`,
    ),
  ];
  return {
    candidate,
    reviewReasons: [...new Set(reviewReasons.map((reason) => reason.trim()).filter(Boolean))],
  };
}

function labelText(extraction: BottleExtractorResult): string {
  const lines =
    extraction.canonical_label_text_lines.length === 0
      ? extraction.raw_text_by_image.map((image) => image.text).join("\n\n")
      : extraction.canonical_label_text_lines.join("\n");
  return lines.trim().slice(0, 4_000);
}

function text(value: string | null): string {
  return value?.trim() ?? "";
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
