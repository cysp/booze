/* oxlint-disable import/max-dependencies -- Capture review composes controls and shared catalogue contracts. */
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Selector } from "@astryxdesign/core/Selector";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useEffect, useRef, useState, type ReactElement } from "react";

import type {
  CaptureImportAction,
  CaptureReviewSaveAction,
  CaptureReviewCandidate,
} from "../shared/capture-import.ts";
import { captureReviewCandidateSchema } from "../shared/capture-review.ts";
import { hasWineIdentity } from "../shared/wine-identity.ts";
import { WineRecordPicker } from "./WineRecordPicker.tsx";
import type { AuthHeadersProvider } from "./useReadPage.ts";
import type { WineOption } from "../shared/wine-options.ts";
import { GrapeVarietiesInput } from "./GrapeVarietiesInput.tsx";
import type { CaptureResource } from "./inventory-model.ts";

const wineFields = [
  ["wineryName", "Producer / winery"],
  ["brandName", "Label / brand"],
  ["designation", "Wine name / designation (optional)"],
  ["vintageYear", "Vintage year"],
  ["country", "Country"],
  ["region", "Region"],
  ["appellation", "Appellation"],
  ["classification", "Classification"],
  ["wineType", "Style"],
  ["wineColor", "Colour"],
  ["addressQualification", "Producer address"],
  ["alcoholPercent", "Alcohol (%)"],
  ["drinkFromYear", "Drink from"],
  ["drinkToYear", "Drink to"],
  ["description", "Description"],
  ["drinkingAdvice", "Drinking advice"],
  ["labelText", "Label text"],
  ["sourceUrl", "Source URL"],
  ["notes", "Wine notes and extraction disagreements"],
] as const;
const bottleFields = [
  ["bottleNumber", "Bottle number"],
  ["volumeMl", "Bottle size (ml)"],
  ["barcode", "Barcode"],
  ["lotCode", "Lot code"],
  ["notes", "Bottle notes"],
] as const;
const numericFields: ReadonlySet<string> = new Set([
  "vintageYear",
  "alcoholPercent",
  "drinkFromYear",
  "drinkToYear",
  "volumeMl",
]);
type ReviewDraft = {
  readonly grapeVarieties: readonly string[];
  readonly wine: Readonly<Record<string, string>>;
  readonly bottle: Readonly<Record<string, string>>;
  readonly unresolvedNumbers: readonly string[];
};

export function CaptureReview({
  capture,
  wines,
  getAuthHeaders,
  canWrite,
  disabled,
  onDirtyChange,
  onBusyChange,
  onImport,
  onSaveReview,
}: {
  readonly capture: CaptureResource;
  readonly wines: readonly WineOption[];
  readonly getAuthHeaders?: AuthHeadersProvider | undefined;
  readonly canWrite: boolean;
  readonly disabled: boolean;
  readonly onDirtyChange: (dirty: boolean) => void;
  readonly onBusyChange: (busy: boolean) => void;
  readonly onImport: CaptureImportAction;
  readonly onSaveReview: CaptureReviewSaveAction;
}): ReactElement {
  const initial = capture.reviewCandidate ?? capture.latestRun?.importCandidate;
  const original = capture.latestRun?.importCandidate;
  const [draft, setDraft] = useState(() => reviewDraft(initial, original));
  const [savedDraft, setSavedDraft] = useState(draft);
  const [revision, setRevision] = useState(capture.reviewRevision);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [message, setMessage] = useState<{ readonly text: string; readonly error: boolean } | null>(
    null,
  );
  const dirty = JSON.stringify(draft) !== JSON.stringify(savedDraft);
  const blocked = disabled || pending || !canWrite;
  const needsSavedCandidate = revision === 0 && isMissing(objectField(initial, "wine"));
  const volumeRequired = validationIssues(original).some(
    (issue) => issue.path === "bottle.volumeMl",
  );
  const problems = draftProblems(draft, volumeRequired);
  const invalidBottle = problems.some((problem) => problem.path[0] === "bottle");
  const invalidWine = problems.some((problem) => problem.path[0] === "wine");
  const identified = hasWineIdentity({
    ...draft.wine,
    grapeVarieties: draft.grapeVarieties,
  });
  const sourceVersion = JSON.stringify([
    capture.latestRun?.id ?? "manual",
    capture.reviewRevision,
    initial,
  ]);
  const observedSourceVersion = useRef(sourceVersion);
  useEffect(() => {
    if (observedSourceVersion.current === sourceVersion) return;
    if (dirty || capture.reviewRevision < revision) return;
    observedSourceVersion.current = sourceVersion;
    const refreshed = reviewDraft(
      capture.reviewCandidate ?? capture.latestRun?.importCandidate,
      original,
    );
    setDraft(refreshed);
    setSavedDraft(refreshed);
    setRevision(capture.reviewRevision);
  }, [
    capture.latestRun?.importCandidate,
    capture.reviewCandidate,
    capture.reviewRevision,
    dirty,
    revision,
    sourceVersion,
    original,
  ]);
  const reasons = stringValues(objectField(capture.latestRun?.importResult, "reviewReasons"));

  function update(section: "wine" | "bottle", key: string, value: string): void {
    const changesVintageStatus = section === "wine" && key === "vintageStatus";
    const next = {
      ...draft,
      [section]: {
        ...draft[section],
        [key]: value,
        ...(changesVintageStatus && value !== "year" ? { vintageYear: "" } : {}),
      },
      unresolvedNumbers: draft.unresolvedNumbers.filter(
        (path) =>
          path !== `${section}.${key}` && !(changesVintageStatus && path === "wine.vintageYear"),
      ),
    };
    setDraft(next);
    onDirtyChange(JSON.stringify(next) !== JSON.stringify(savedDraft));
    setMessage(null);
  }

  async function save(): Promise<void> {
    if (blocked || pendingRef.current) return;
    const problem = problems[0];
    if (problem !== undefined) {
      setMessage({ error: true, text: problem.message });
      return;
    }
    const candidate = draftCandidate(draft);
    pendingRef.current = true;
    setPending(true);
    onBusyChange(true);
    try {
      const result = await onSaveReview(capture.id, revision, candidate);
      if (!result.ok) {
        setMessage({ error: true, text: result.message });
        return;
      }
      const saved = reviewDraft(result.reviewCandidate, original);
      setDraft(saved);
      setSavedDraft(saved);
      setRevision(result.reviewRevision);
      onDirtyChange(false);
      setMessage({
        error: false,
        text: "Corrections saved. Confirm adding the bottles when ready.",
      });
    } catch {
      setMessage({
        error: true,
        text: "Corrections could not be confirmed saved. Your edits are still here; refresh capture status before trying again.",
      });
    } finally {
      pendingRef.current = false;
      setPending(false);
      onBusyChange(false);
    }
  }

  async function importWine(wineVintageId?: string, allowUnidentified = false): Promise<void> {
    if (
      dirty ||
      blocked ||
      needsSavedCandidate ||
      pendingRef.current ||
      invalidBottle ||
      (wineVintageId === undefined && invalidWine)
    )
      return;
    pendingRef.current = true;
    setPending(true);
    onBusyChange(true);
    setMessage(null);
    try {
      const result = await onImport(capture.id, wineVintageId, {
        expectedReviewRevision: revision,
        ...(allowUnidentified ? { allowUnidentified: true } : {}),
      });
      if (!result.ok) setMessage({ error: true, text: result.message });
    } catch {
      setMessage({
        error: true,
        text: "The import result could not be confirmed. Refresh capture status before trying again.",
      });
    } finally {
      pendingRef.current = false;
      setPending(false);
      onBusyChange(false);
    }
  }

  return (
    <details className="capture-disclosure" open>
      <summary>Review wine and bottle details</summary>
      <div className="capture-review">
        <p>
          Extraction is a draft. Check the photos and details, then confirm adding{" "}
          {capture.quantity} {capture.quantity === 1 ? "bottle" : "bottles"} to inventory. Saving
          corrections does not add bottles.
        </p>
        <p>
          A separate wine name is optional. Selecting an existing wine leaves its shared details
          unchanged. Clear an uncertain wine number to record it as unknown, or choose Unknown for
          an uncertain vintage.
        </p>
        {reasons.length === 0 ? null : (
          <ul aria-label="Reasons this capture needs review">
            {reasons.map((reason, index) => (
              <li key={`${index}-${reason}`}>{reason}</li>
            ))}
          </ul>
        )}
        <OriginalCaptureFacts candidate={capture.latestRun?.importCandidate} />
        <div className="field-row">
          <Selector
            label="Vintage status"
            htmlName={`${capture.id}.vintageStatus`}
            isDisabled={blocked}
            value={draft.wine["vintageStatus"] ?? "unknown"}
            options={[
              { label: "Unknown", value: "unknown" },
              { label: "Year shown", value: "year" },
              { label: "Non-vintage (explicit)", value: "non_vintage" },
            ]}
            onChange={(value: string) => {
              update("wine", "vintageStatus", value);
            }}
          />
          {wineFields.map(([key, label]) => (
            <CaptureReviewField
              fieldKey={key}
              key={key}
              label={label}
              htmlName={`${capture.id}.wine.${key}`}
              value={draft.wine[key] ?? ""}
              isDisabled={
                blocked || (key === "vintageYear" && draft.wine["vintageStatus"] !== "year")
              }
              onChange={(value: string) => {
                update("wine", key, value);
              }}
            />
          ))}
          <GrapeVarietiesInput
            disabled={blocked}
            name={`${capture.id}.wine.grapeVarieties`}
            value={draft.grapeVarieties}
            onChange={(grapeVarieties) => {
              const next = { ...draft, grapeVarieties };
              setDraft(next);
              onDirtyChange(JSON.stringify(next) !== JSON.stringify(savedDraft));
              setMessage(null);
            }}
          />
          {bottleFields.map(([key, label]) => (
            <CaptureReviewField
              fieldKey={key}
              key={key}
              label={label}
              htmlName={`${capture.id}.bottle.${key}`}
              value={draft.bottle[key] ?? ""}
              isDisabled={blocked}
              onChange={(value: string) => {
                update("bottle", key, value);
              }}
            />
          ))}
        </div>
        <ReviewDraftStatus
          volumeMl={draft.bottle["volumeMl"]}
          volumeRequired={volumeRequired}
          invalidBottle={invalidBottle}
          invalidWine={invalidWine}
          needsSavedCandidate={needsSavedCandidate}
          dirty={dirty}
        />
        {capture.reviewRevision > revision ? (
          <div>
            <p>Newer saved corrections are available. Loading them replaces your unsaved edits.</p>
            <Button
              label="Load latest corrections"
              isDisabled={blocked}
              onClick={() => {
                const latest = reviewDraft(capture.reviewCandidate, original);
                setDraft(latest);
                setSavedDraft(latest);
                setRevision(capture.reviewRevision);
                onDirtyChange(false);
                setMessage(null);
              }}
            />
          </div>
        ) : null}
        <CaptureReviewActions
          canWrite={canWrite}
          blocked={blocked}
          dirty={dirty}
          pending={pending}
          needsSavedCandidate={needsSavedCandidate}
          identified={identified}
          invalidBottle={invalidBottle}
          invalidWine={invalidWine}
          candidates={wineVintageCandidates(capture.latestRun?.matchResult, revision)}
          wines={wines}
          getAuthHeaders={getAuthHeaders}
          siteId={capture.siteId}
          reviewRevision={revision}
          onSave={save}
          onImport={importWine}
        />
        {message === null ? null : (
          <Banner
            aria-live="polite"
            status={message.error ? "error" : "success"}
            title={message.text}
          />
        )}
      </div>
    </details>
  );
}

function reviewDraft(candidate: unknown, original: unknown): ReviewDraft {
  const wine = objectField(candidate, "wine");
  const bottle = objectField(candidate, "bottle");
  const unresolved = validationIssues(original).filter((issue) => {
    const [section, key] = issue.path.split(".");
    return (
      (section === "wine" || section === "bottle") &&
      key !== undefined &&
      numericFields.has(key) &&
      !hasField(section === "wine" ? wine : bottle, key)
    );
  });
  function value(section: "wine" | "bottle", key: string): string {
    return (
      unresolved.find((issue) => issue.path === `${section}.${key}`)?.rawValue ??
      displayField(objectField(section === "wine" ? wine : bottle, key))
    );
  }
  return {
    grapeVarieties: stringValues(objectField(wine, "grapeVarieties")),
    unresolvedNumbers: unresolved.map((issue) => issue.path),
    wine: {
      ...Object.fromEntries(wineFields.map(([key]) => [key, value("wine", key)])),
      vintageStatus:
        (unresolved.some((issue) => issue.path === "wine.vintageYear") ? "year" : "") ||
        displayField(objectField(wine, "vintageStatus")) ||
        (typeof objectField(wine, "vintageYear") === "number" ? "year" : "unknown"),
    },
    bottle: Object.fromEntries(bottleFields.map(([key]) => [key, value("bottle", key)])),
  };
}
function draftFields(
  values: Readonly<Record<string, string>>,
  nullableNumbers: boolean,
): Record<string, string | number | null> {
  return Object.fromEntries(
    Object.entries(values).flatMap<[string, string | number | null]>(([key, value]) => {
      if (numericFields.has(key))
        return value.trim() === ""
          ? nullableNumbers
            ? [[key, null]]
            : []
          : [[key, Number(value)]];
      return [[key, value.trim()]];
    }),
  );
}
function draftCandidate(draft: ReviewDraft): CaptureReviewCandidate {
  const wine = draftFields(draft.wine, true);
  if (wine["vintageStatus"] !== "year") wine["vintageYear"] = null;
  const status = draft.wine["vintageStatus"];
  return {
    wine: {
      ...wine,
      grapeVarieties: [...draft.grapeVarieties]
        .map((value) => value.trim())
        .filter((value) => value !== ""),
      wineryName: (draft.wine["wineryName"] ?? "").trim(),
      designation: (draft.wine["designation"] ?? "").trim(),
      vintageStatus: status === "year" || status === "non_vintage" ? status : "unknown",
    },
    bottle: draftFields(draft.bottle, false),
  };
}
function facts(
  value: unknown,
  fields: readonly (readonly [string, string])[],
): readonly { readonly label: string; readonly value: string }[] {
  return fields.flatMap(([key, label]) => {
    const display = displayField(objectField(value, key));
    return display.trim() === "" ? [] : [{ label, value: display }];
  });
}
function displayField(value: unknown): string {
  return typeof value === "number"
    ? String(value)
    : typeof value === "string"
      ? value
      : stringValues(value).join(", ");
}
function stringValues(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((part): part is string => typeof part === "string")
    : [];
}
function objectField(value: unknown, field: string): unknown {
  return typeof value === "object" && value !== null
    ? Object.getOwnPropertyDescriptor(value, field)?.value
    : undefined;
}
function hasField(value: unknown, field: string): boolean {
  return typeof value === "object" && value !== null && Object.hasOwn(value, field);
}
function validationIssues(
  candidate: unknown,
): readonly { readonly path: string; readonly rawValue: string; readonly message: string }[] {
  const issues = objectField(candidate, "validationIssues");
  return Array.isArray(issues)
    ? issues.flatMap((issue) => {
        const path = objectField(issue, "path");
        const rawValue = objectField(issue, "rawValue");
        const message = objectField(issue, "message");
        return typeof path === "string" &&
          typeof rawValue === "string" &&
          typeof message === "string"
          ? [{ path, rawValue, message }]
          : [];
      })
    : [];
}
function wineVintageCandidates(
  value: unknown,
  revision: number,
): readonly { readonly id: string; readonly label: string }[] {
  if (revision > 0) return [];
  const candidates = objectField(value, "wineVintageCandidates");
  return Array.isArray(candidates)
    ? candidates.flatMap((candidate) => {
        const id = objectField(candidate, "id");
        const label = objectField(candidate, "label");
        return typeof id === "string" && typeof label === "string" ? [{ id, label }] : [];
      })
    : [];
}

function fieldLabel(path: readonly PropertyKey[]): string {
  const fields = path[0] === "bottle" ? bottleFields : wineFields;
  return fields.find(([key]) => key === path[1])?.[1] ?? "Wine details";
}

function CaptureReviewActions({
  canWrite,
  blocked,
  dirty,
  pending,
  needsSavedCandidate,
  identified,
  invalidBottle,
  invalidWine,
  candidates,
  wines,
  getAuthHeaders,
  siteId,
  reviewRevision,
  onSave,
  onImport,
}: {
  readonly canWrite: boolean;
  readonly blocked: boolean;
  readonly dirty: boolean;
  readonly pending: boolean;
  readonly needsSavedCandidate: boolean;
  readonly identified: boolean;
  readonly invalidBottle: boolean;
  readonly invalidWine: boolean;
  readonly candidates: readonly { readonly id: string; readonly label: string }[];
  readonly wines: readonly WineOption[];
  readonly getAuthHeaders?: AuthHeadersProvider | undefined;
  readonly siteId: string;
  readonly reviewRevision: number;
  readonly onSave: () => Promise<void>;
  readonly onImport: (wineVintageId?: string, allowUnidentified?: boolean) => Promise<void>;
}): ReactElement | null {
  return canWrite ? (
    <div className="card-actions">
      <Button
        label="Save corrections"
        isDisabled={blocked || (!dirty && !needsSavedCandidate)}
        isLoading={pending}
        onClick={() => {
          void onSave();
        }}
      />
      <CaptureWineChoice
        key={reviewRevision}
        wines={wines}
        getAuthHeaders={getAuthHeaders}
        siteId={siteId}
        disabled={blocked || dirty || needsSavedCandidate || invalidBottle}
        onImport={onImport}
      />
      {candidates.map((candidate) => (
        <Button
          key={candidate.id}
          label={`Add bottles to ${candidate.label}`}
          isDisabled={blocked || dirty || needsSavedCandidate || invalidBottle}
          onClick={() => {
            void onImport(candidate.id);
          }}
        />
      ))}
      <Button
        label="Add bottles as new wine"
        isDisabled={
          blocked || dirty || needsSavedCandidate || !identified || invalidBottle || invalidWine
        }
        onClick={() => {
          void onImport();
        }}
      />
      {identified ? null : (
        <Button
          label="Add bottles as unidentified wine"
          isDisabled={blocked || dirty || needsSavedCandidate || invalidBottle || invalidWine}
          onClick={() => {
            void onImport(undefined, true);
          }}
        />
      )}
    </div>
  ) : null;
}
function isMissing(value: unknown): boolean {
  return value === null || value === undefined;
}

function ReviewDraftStatus({
  volumeMl,
  volumeRequired,
  invalidBottle,
  invalidWine,
  needsSavedCandidate,
  dirty,
}: {
  readonly volumeMl: string | undefined;
  readonly volumeRequired: boolean;
  readonly invalidBottle: boolean;
  readonly invalidWine: boolean;
  readonly needsSavedCandidate: boolean;
  readonly dirty: boolean;
}): ReactElement {
  return (
    <>
      {volumeMl?.trim() === "" && !volumeRequired ? (
        <p>
          No bottle size is set. Adding bottles uses 750 mL by default unless you enter and save a
          different size.
        </p>
      ) : null}
      {invalidBottle ? (
        <p>
          Correct and save the bottle details before adding bottles, including to an existing wine.
        </p>
      ) : null}
      {invalidWine ? (
        <p>
          Correct and save the uncertain wine values, or select an existing wine to keep its shared
          details.
        </p>
      ) : null}
      {needsSavedCandidate ? (
        <p>Save these details before adding this capture to inventory.</p>
      ) : null}
      {dirty ? (
        <p role="status">
          Unsaved corrections. Save them before adding bottles or retrying extraction.
        </p>
      ) : null}
    </>
  );
}

function OriginalCaptureFacts({ candidate }: { readonly candidate: unknown }): ReactElement {
  return (
    <details className="capture-disclosure">
      <summary>Original extracted facts</summary>
      {isMissing(candidate) ? (
        <p>Extracted facts are unavailable. Enter details manually or retry extraction.</p>
      ) : null}
      <dl>
        {[
          ...facts(objectField(candidate, "wine"), [
            ...wineFields,
            ["grapeVarieties", "Grape varieties"],
            ["displayName", "Extracted display name"],
            ["baseName", "Extracted base name"],
          ]),
          ...facts(objectField(candidate, "bottle"), bottleFields),
        ].map(({ label, value }) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {validationIssues(candidate).length === 0 ? null : (
        <ul aria-label="Original extraction issues">
          {validationIssues(candidate).map((issue, index) => (
            <li key={`${index}-${issue.path}`}>
              {fieldLabel(issue.path.split("."))}: {issue.rawValue}. {issue.message}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

function CaptureReviewField({
  fieldKey,
  ...props
}: {
  readonly fieldKey: string;
  readonly label: string;
  readonly htmlName: string;
  readonly value: string;
  readonly isDisabled: boolean;
  readonly onChange: (value: string) => void;
}): ReactElement {
  return ["notes", "description", "drinkingAdvice", "labelText"].includes(fieldKey) ? (
    <TextArea {...props} />
  ) : (
    <TextInput {...props} />
  );
}

function CaptureWineChoice({
  wines,
  getAuthHeaders,
  siteId,
  disabled,
  onImport,
}: {
  readonly wines: readonly WineOption[];
  readonly getAuthHeaders?: AuthHeadersProvider | undefined;
  readonly siteId: string;
  readonly disabled: boolean;
  readonly onImport: (wineVintageId: string) => Promise<void>;
}): ReactElement {
  const [selected, setSelected] = useState("");
  return (
    <div>
      <WineRecordPicker
        label="Existing wine in this site"
        siteId={siteId}
        wines={getAuthHeaders === undefined ? wines : undefined}
        getAuthHeaders={getAuthHeaders}
        selected={selected}
        disabled={disabled}
        onChange={setSelected}
      />
      <Button
        label="Add bottles to selected wine"
        isDisabled={disabled || selected === ""}
        onClick={() => {
          void onImport(selected);
        }}
      />
    </div>
  );
}

function invalidNumericField(draft: ReviewDraft): readonly string[] | null {
  for (const section of ["wine", "bottle"] as const) {
    for (const [key, value] of Object.entries(draft[section])) {
      if (key === "vintageYear" && draft.wine["vintageStatus"] !== "year") continue;
      if (numericFields.has(key) && value.trim() !== "" && !Number.isFinite(Number(value)))
        return [section, key];
    }
  }
  return null;
}

function draftProblems(
  draft: ReviewDraft,
  volumeRequired: boolean,
): readonly { readonly path: readonly PropertyKey[]; readonly message: string }[] {
  const invalidNumber = invalidNumericField(draft);
  const parsed = captureReviewCandidateSchema.safeParse(draftCandidate(draft));
  return [
    ...(invalidNumber === null
      ? []
      : [
          { path: invalidNumber, message: `${fieldLabel(invalidNumber)} must be a finite number.` },
        ]),
    ...draft.unresolvedNumbers.map((path) => ({
      path: path.split("."),
      message: `Check and re-enter ${fieldLabel(path.split("."))} from the photos, or clear an uncertain wine value.`,
    })),
    ...(volumeRequired && draft.bottle["volumeMl"]?.trim() === ""
      ? [
          {
            path: ["bottle", "volumeMl"],
            message:
              "Enter and save a valid bottle size; the original size issue cannot use the default.",
          },
        ]
      : []),
    ...(parsed.success
      ? []
      : parsed.error.issues.map((issue) => ({
          path: issue.path,
          message: `${fieldLabel(issue.path)}: ${issue.message}`,
        }))),
  ];
}
