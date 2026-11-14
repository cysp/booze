// oxlint-disable import/max-dependencies -- Catalogue controllers coordinate domain payloads, durable addition identity, and mutation feedback.
import { contentDigest } from "../shared/addition-operation.ts";
import { PendingAdditionChangedError, useAdditionOperation } from "./useAdditionOperation.ts";
import { useEffect, useState, type Dispatch, type SetStateAction } from "react";

import type {
  CaptureImportAction,
  CaptureImportResult,
  CaptureImportOptions,
  CaptureReviewSaveAction,
  CaptureReviewSaveResult,
} from "../shared/capture-import.ts";
import type { CaptureReviewCandidate } from "../shared/capture-review.ts";
import { validateBottleQuantity } from "../shared/quantity.ts";
import { bottleCreatePayload, bottleEditPayload } from "./bottle-payload.ts";
import type { BottleModalSubmit, BottleModalSubmitResult } from "./BottleModal.tsx";
import type { CaptureSubmitResult } from "./CaptureView.tsx";
import type { MutationCompletion } from "./useCatalogue.ts";
import {
  formStateForItem,
  initialCaptureFormState,
  initialFormState,
  initialLocationFormState,
  initialSiteFormState,
  locationPath,
  type BottlePatch,
  type CaptureFormState,
  type FormState,
  type InventoryItem,
  type LocationFormState,
  type LocationItem,
  type SiteFormState,
  type SiteItem,
} from "./inventory-model.ts";
import { useNamedResourceActions, type NamedResourceActions } from "./useNamedResourceActions.ts";

type SharedControllerContext = {
  readonly additionScope?: string;
  readonly completeMutation: (completion: MutationCompletion) => Promise<void>;
  readonly getAuthHeaders: () => Promise<Record<string, string>>;
  readonly setStatus: (status: string) => void;
};

export type BottleController = {
  readonly addFormDefaults: FormState;
  readonly cancelAddition: (siteId: string) => void;
  readonly deleteBottle: (bottleId: string) => Promise<boolean>;
  readonly editingBottle: InventoryItem | null;
  readonly editingForm: FormState | null;
  readonly isAddOpen: boolean;
  readonly isSaving: boolean;
  readonly openBottleEditor: Dispatch<SetStateAction<InventoryItem | null>>;
  readonly saveBottle: (submission: BottleModalSubmit) => Promise<BottleModalSubmitResult>;
  readonly saveBottleEdit: (submission: BottleModalSubmit) => Promise<BottleModalSubmitResult>;
  readonly setEditingBottle: Dispatch<SetStateAction<InventoryItem | null>>;
  readonly setIsAddOpen: Dispatch<SetStateAction<boolean>>;
  readonly updateBottle: (request: {
    readonly bottleId: string;
    readonly payload: BottlePatch;
  }) => Promise<boolean>;
  readonly useLocation: (location: LocationItem) => void;
};

export type CaptureController = {
  readonly captureForm: CaptureFormState;
  readonly cancelAddition: (siteId: string) => void;
  readonly deleteCapture: (captureId: string) => Promise<boolean>;
  readonly importCapture: CaptureImportAction;
  readonly saveCaptureReview: CaptureReviewSaveAction;
  readonly isSaving: boolean;
  readonly retryCapture: (captureId: string) => Promise<boolean>;
  readonly setCaptureForm: Dispatch<SetStateAction<CaptureFormState>>;
  readonly submitCapture: (
    form: CaptureFormState,
    files: readonly File[],
  ) => Promise<CaptureSubmitResult>;
};

export type LocationController = {
  readonly form: LocationFormState;
  readonly resourceActions: NamedResourceActions;
  readonly save: () => Promise<boolean>;
  readonly updateField: (field: keyof LocationFormState, value: string) => void;
};

export type SiteController = {
  readonly form: SiteFormState;
  readonly resourceActions: NamedResourceActions;
  readonly save: () => Promise<boolean>;
  readonly updateField: (field: keyof SiteFormState, value: string) => void;
};

export function useBottleController({
  additionScope = "development",
  completeMutation,
  getAuthHeaders,
  locations,
  setStatus,
  writableSites,
}: SharedControllerContext & {
  readonly locations: readonly LocationItem[];
  readonly writableSites: readonly SiteItem[];
}): BottleController {
  const [addFormDefaults, setAddFormDefaults] = useState<FormState>(initialFormState);
  const [editingBottle, setEditingBottle] = useState<InventoryItem | null>(null);
  const [isAddOpen, setIsAddOpen] = useState(false);
  const addition = useAdditionOperation("bottles", additionScope);
  function cancelAddition(siteId: string): void {
    addition.clear(siteId);
    setIsAddOpen(false);
  }
  const [isSaving, setIsSaving] = useState(false);
  const editingForm = editingBottle === null ? null : formStateForItem(editingBottle);

  useDefaultSite(writableSites, setAddFormDefaults);

  async function saveBottle(submission: BottleModalSubmit): Promise<BottleModalSubmitResult> {
    const { form } = submission;
    if (form.siteId === "") {
      const message = "Choose a site before saving the bottle.";
      setStatus(message);
      return { message, ok: false };
    }
    const quantity = validateBottleQuantity(form.quantity);
    if (!quantity.ok) {
      setStatus(quantity.message);
      return { message: quantity.message, ok: false };
    }
    setIsSaving(true);
    setStatus("Saving bottle...");
    try {
      const payload = {
        ...bottleCreatePayload(submission),
        siteId: form.siteId,
        quantity: quantity.value,
      };
      const operationId = await addition.operationId(form.siteId, payload);
      const response = await fetch("/api/bottles", {
        method: "POST",
        headers: jsonHeaders(await getAuthHeaders()),
        body: JSON.stringify({
          ...payload,
          operationId,
        }),
      });
      if (!response.ok) {
        if ([400, 413, 415, 422].includes(response.status)) addition.clear(form.siteId);
        const message =
          response.status >= 500
            ? "The bottle save could not be confirmed. Your details are still here; retry without changing them to check the same addition."
            : ((await responseErrorMessage(response)) ??
              "Bottle was not saved. Check the entered details.");
        setStatus(message);
        return { message, ok: false };
      }
      setAddFormDefaults({
        ...initialFormState,
        siteId: form.siteId,
        site: form.site,
        storageLocationId: form.storageLocationId,
        location: form.location,
        position: form.position,
      });
      addition.clear(form.siteId);
      setIsAddOpen(false);
    } catch (error) {
      const message =
        error instanceof PendingAdditionChangedError
          ? error.message
          : "The bottle save could not be confirmed. Your details are still here; retry without changing them to check the same addition.";
      setStatus(message);
      return { message, ok: false };
    } finally {
      setIsSaving(false);
    }
    try {
      await completeMutation({ refresh: "catalogue", successMessage: "Bottle saved." });
    } catch {
      setStatus("Bottle saved. Catalogue refresh failed; refresh to see the saved bottle.");
    }
    return { ok: true };
  }

  async function patchBottle({
    bottleId,
    payload,
  }: {
    readonly bottleId: string;
    readonly payload: BottlePatch;
  }): Promise<BottleModalSubmitResult> {
    setStatus("Updating bottle...");
    const response = await fetch(`/api/bottles/${encodeURIComponent(bottleId)}`, {
      method: "PATCH",
      headers: jsonHeaders(await getAuthHeaders()),
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const message =
        (await responseErrorMessage(response)) ??
        "Bottle was not updated. Refresh inventory and try again.";
      setStatus(message);
      return { ok: false, message };
    }
    await completeMutation({ refresh: "catalogue", successMessage: "Inventory updated." });
    return { ok: true };
  }

  async function updateBottle(input: {
    readonly bottleId: string;
    readonly payload: BottlePatch;
  }): Promise<boolean> {
    return (await patchBottle(input)).ok;
  }

  async function deleteBottle(bottleId: string): Promise<boolean> {
    setStatus("Deleting bottle...");
    const response = await fetch(`/api/bottles/${encodeURIComponent(bottleId)}`, {
      method: "DELETE",
      headers: await getAuthHeaders(),
    });
    if (!response.ok) {
      setStatus("Bottle was not deleted.");
      return false;
    }
    await completeMutation({ refresh: "catalogue", successMessage: "Bottle deleted." });
    return true;
  }

  async function saveBottleEdit(submission: BottleModalSubmit): Promise<BottleModalSubmitResult> {
    if (editingBottle === null) {
      return { message: "Bottle is no longer available to edit.", ok: false };
    }
    setIsSaving(true);
    try {
      const updated = await patchBottle({
        bottleId: editingBottle.id,
        payload: bottleEditPayload(submission, editingBottle),
      });
      if (updated.ok) {
        setEditingBottle(null);
        return { ok: true };
      }
      return updated;
    } catch {
      const message = "Bottle was not updated. Check your connection and try again.";
      setStatus(message);
      return { message, ok: false };
    } finally {
      setIsSaving(false);
    }
  }

  function useLocation(location: LocationItem): void {
    setAddFormDefaults((current) => ({
      ...current,
      siteId: location.siteId,
      site: location.siteName,
      storageLocationId: location.id,
      location: locationPath(location, locations),
      position: "",
    }));
    setIsAddOpen(true);
  }

  return {
    addFormDefaults,
    cancelAddition,
    deleteBottle,
    editingBottle,
    editingForm,
    isAddOpen,
    isSaving,
    openBottleEditor: setEditingBottle,
    saveBottle,
    saveBottleEdit,
    setEditingBottle,
    setIsAddOpen,
    updateBottle,
    useLocation,
  };
}

export function useCaptureController({
  additionScope = "development",
  completeMutation,
  getAuthHeaders,
  setStatus,
  writableSites,
}: SharedControllerContext & {
  readonly writableSites: readonly SiteItem[];
}): CaptureController {
  const [captureForm, setCaptureForm] = useState<CaptureFormState>(initialCaptureFormState);
  const addition = useAdditionOperation("capture", additionScope);
  const [isSaving, setIsSaving] = useState(false);
  useDefaultSite(writableSites, setCaptureForm);

  async function submitCapture(
    form: CaptureFormState,
    files: readonly File[],
  ): Promise<CaptureSubmitResult> {
    if (form.siteId === "") {
      const message = "Choose a site before submitting the capture.";
      setStatus(message);
      return { kind: "failed", message };
    }
    const quantity = validateBottleQuantity(form.quantity);
    if (!quantity.ok) {
      setStatus(quantity.message);
      return { kind: "failed", message: quantity.message };
    }
    setIsSaving(true);
    setStatus("Submitting capture...");
    let savedResult: CaptureSubmitResult | undefined;
    try {
      const operationId = await addition.operationId(form.siteId, {
        siteId: form.siteId,
        storageLocationId: form.storageLocationId || null,
        positionHint: form.position,
        quantity: quantity.value,
        images: await Promise.all(
          files.map(async (file) => ({
            name: file.name,
            contentType: file.type,
            size: file.size,
            digest: await contentDigest(await file.arrayBuffer()),
          })),
        ),
      });
      const formData = new FormData();
      formData.append("operationId", operationId);
      formData.append("siteId", form.siteId);
      if (form.storageLocationId !== "") {
        formData.append("storageLocationId", form.storageLocationId);
      }
      formData.append("positionHint", form.position);
      formData.append("quantity", String(quantity.value));
      for (const file of files) {
        formData.append("images", file);
      }
      const response = await fetch("/api/bottle-captures", {
        method: "POST",
        headers: await getAuthHeaders(),
        body: formData,
      });
      if (!response.ok) {
        if ([400, 413, 415, 422].includes(response.status)) addition.clear(form.siteId);
        const message = await responseErrorMessage(response);
        const statusMessage =
          response.status >= 500
            ? "The capture submission could not be confirmed. Your photos are still here; retry without changing them to check the same capture."
            : message === null
              ? "Capture was not submitted."
              : `Capture failed: ${message}`;
        setStatus(statusMessage);
        return { kind: "failed", message: statusMessage };
      }
      let responsePayload: unknown;
      try {
        responsePayload = await response.json();
      } catch {
        const message =
          "Capture is saved, but upload completion could not be confirmed. Keep these photos and retry the same capture.";
        savedResult = { kind: "pending", message };
        await completeMutation({ refresh: "captures", successMessage: message });
        return savedResult;
      }
      const data = objectProperty(responsePayload, "data");
      if (objectProperty(data, "intakeComplete") !== true) {
        const message =
          captureSubmitErrorMessage(responsePayload) ??
          "Capture is saved, but its image upload is incomplete. Keep these photos and retry the same capture.";
        savedResult = { kind: "pending", message };
        await completeMutation({ refresh: "captures", successMessage: message });
        return savedResult;
      }
      savedResult = {
        kind: "submitted",
        message: "Capture submitted. Extraction will run in the background.",
      };
      addition.clear(form.siteId);
      setCaptureForm({
        siteId: form.siteId,
        site: form.site,
        storageLocationId: form.storageLocationId,
        location: form.location,
        position: form.position,
        quantity: "1",
      });
      const message = captureSubmitErrorMessage(responsePayload);
      if (message !== null) {
        const statusMessage = `Capture saved: ${message}`;
        savedResult = { kind: "saved_with_error", message: statusMessage };
        await completeMutation({ refresh: "catalogue", successMessage: statusMessage });
        return { kind: "saved_with_error", message: statusMessage };
      }
      const statusMessage = "Capture submitted. Extraction will run in the background.";
      await completeMutation({ refresh: "catalogue", successMessage: statusMessage });
      return { kind: "submitted", message: statusMessage };
    } catch (error) {
      if (savedResult !== undefined) {
        setStatus(
          `${savedResult.message} Catalogue refresh failed; refresh to see the saved capture.`,
        );
        return savedResult;
      }
      const message =
        error instanceof PendingAdditionChangedError
          ? error.message
          : "The capture submission could not be confirmed. Your photos are still here; retry without changing them to check the same capture.";
      setStatus(message);
      return { kind: "failed", message };
    } finally {
      setIsSaving(false);
    }
  }

  async function retryCapture(captureId: string): Promise<boolean> {
    setStatus("Retrying capture...");
    const response = await fetch(`/api/bottle-captures/${encodeURIComponent(captureId)}/retry`, {
      method: "POST",
      headers: await getAuthHeaders(),
    });
    if (!response.ok) {
      setStatus("Capture was not retried.");
      return false;
    }
    await completeMutation({ refresh: "captures", successMessage: "Capture retry started." });
    return true;
  }

  async function importCapture(
    captureId: string,
    wineVintageId?: string,
    options?: CaptureImportOptions,
  ): Promise<CaptureImportResult> {
    setStatus("Importing capture...");
    try {
      const response = await fetch(`/api/bottle-captures/${encodeURIComponent(captureId)}/import`, {
        method: "POST",
        headers: jsonHeaders(await getAuthHeaders()),
        body: JSON.stringify({
          ...options,
          ...(wineVintageId === undefined ? {} : { wineVintageId }),
        }),
      });
      if (!response.ok) {
        const message =
          (await responseErrorMessage(response)) ??
          "The server could not complete the import. Refresh capture status before trying again.";
        setStatus(`Import failed: ${message}`);
        return { ok: false, message };
      }
    } catch {
      const message =
        "The import result could not be confirmed. Check your connection and refresh capture status before trying again.";
      setStatus(message);
      return { ok: false, message };
    }
    await completeMutation({ refresh: "catalogue", successMessage: "Capture imported." });
    return { ok: true };
  }

  async function saveCaptureReview(
    captureId: string,
    expectedRevision: number,
    candidate: CaptureReviewCandidate,
  ): Promise<CaptureReviewSaveResult> {
    setStatus("Saving capture corrections...");
    let reviewRevision: number;
    try {
      const response = await fetch(`/api/bottle-captures/${encodeURIComponent(captureId)}/review`, {
        method: "PATCH",
        headers: jsonHeaders(await getAuthHeaders()),
        body: JSON.stringify({ expectedRevision, candidate }),
      });
      if (!response.ok) {
        const message =
          (await responseErrorMessage(response)) ??
          "Corrections were not saved. Refresh the capture and try again.";
        setStatus(message);
        if (response.status === 409) {
          await completeMutation({ refresh: "captures", successMessage: message });
        }
        return { ok: false, message };
      }
      const result: unknown = await response.json();
      const data = objectProperty(result, "data");
      const revision = objectProperty(data, "reviewRevision");
      if (
        typeof revision !== "number" ||
        !Number.isSafeInteger(revision) ||
        revision !== expectedRevision + 1
      ) {
        throw new Error("Unconfirmed review response");
      }
      reviewRevision = revision;
    } catch {
      const message =
        "The correction save could not be confirmed. Your edits are still here; refresh capture status before saving again.";
      setStatus(message);
      return { ok: false, message };
    }
    await completeMutation({
      refresh: "captures",
      successMessage: "Corrections saved. Review and explicitly add the bottles when ready.",
    });
    return { ok: true, reviewRevision, reviewCandidate: candidate };
  }

  async function deleteCapture(captureId: string): Promise<boolean> {
    setStatus("Deleting capture...");
    const response = await fetch(`/api/bottle-captures/${encodeURIComponent(captureId)}`, {
      method: "DELETE",
      headers: await getAuthHeaders(),
    });
    if (!response.ok) {
      const message = await responseErrorMessage(response);
      setStatus(message === null ? "Capture was not deleted." : `Delete failed: ${message}`);
      return false;
    }
    await completeMutation({ refresh: "captures", successMessage: "Capture deleted." });
    return true;
  }

  return {
    captureForm,
    cancelAddition: addition.clear,
    deleteCapture,
    importCapture,
    isSaving,
    retryCapture,
    saveCaptureReview,
    setCaptureForm,
    submitCapture,
  };
}

export function useLocationController({
  completeMutation,
  getAuthHeaders,
  setStatus,
  writableSites,
}: SharedControllerContext & {
  readonly writableSites: readonly SiteItem[];
}): LocationController {
  const [form, setForm] = useState<LocationFormState>(initialLocationFormState);
  const resourceActions = useNamedResourceActions({
    completeMutation,
    getAuthHeaders,
    kind: "location",
    setStatus,
  });
  useDefaultSite(writableSites, setForm);

  function updateField(field: keyof LocationFormState, value: string): void {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function save(): Promise<boolean> {
    if (form.siteId === "") {
      setStatus("Choose a site before saving the location.");
      return false;
    }
    if (form.location.trim() === "") {
      setStatus("Enter a location name before saving.");
      return false;
    }
    setStatus("Saving location...");
    const response = await fetch("/api/storage-locations", {
      method: "POST",
      headers: jsonHeaders(await getAuthHeaders()),
      body: JSON.stringify({
        siteId: form.siteId,
        parentId: form.parentLocationId === "" ? null : form.parentLocationId,
        name: form.location,
      }),
    });
    if (!response.ok) {
      setStatus("Location was not saved.");
      return false;
    }
    setForm((current) => ({ ...current, location: "" }));
    await completeMutation({ refresh: "catalogue", successMessage: "Location saved." });
    return true;
  }

  return {
    form,
    resourceActions,
    save,
    updateField,
  };
}

export function useSiteController({
  completeMutation,
  getAuthHeaders,
  setStatus,
}: SharedControllerContext): SiteController {
  const [form, setForm] = useState<SiteFormState>(initialSiteFormState);
  const resourceActions = useNamedResourceActions({
    completeMutation,
    getAuthHeaders,
    kind: "site",
    setStatus,
  });

  function updateField(field: keyof SiteFormState, value: string): void {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function save(): Promise<boolean> {
    if (form.site.trim() === "") {
      setStatus("Enter a site name before saving.");
      return false;
    }
    setStatus("Saving site...");
    const response = await fetch("/api/sites", {
      method: "POST",
      headers: jsonHeaders(await getAuthHeaders()),
      body: JSON.stringify({ name: form.site }),
    });
    if (!response.ok) {
      setStatus("Site was not saved.");
      return false;
    }
    setForm(initialSiteFormState);
    await completeMutation({ refresh: "catalogue", successMessage: "Site saved." });
    return true;
  }

  return {
    form,
    resourceActions,
    save,
    updateField,
  };
}

function useDefaultSite<T extends FormState | CaptureFormState | LocationFormState>(
  writableSites: readonly SiteItem[],
  setForm: Dispatch<SetStateAction<T>>,
): void {
  useEffect(() => {
    const writableSiteIds = new Set(writableSites.map((site) => site.id));
    const defaultSite = writableSites[0];
    setForm((current) =>
      writableSiteIds.has(current.siteId)
        ? current
        : {
            ...current,
            siteId: defaultSite?.id ?? "",
            site: defaultSite?.name ?? "",
            storageLocationId: "",
            location: "",
            ...("parentLocationId" in current ? { parentLocationId: "" } : {}),
          },
    );
  }, [setForm, writableSites]);
}

function jsonHeaders(authHeaders: Record<string, string>): Record<string, string> {
  return { "content-type": "application/json", ...authHeaders };
}

async function responseErrorMessage(response: Response): Promise<string | null> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!/^application\/(?:json|problem\+json)(?:\s*;|$)/iu.test(contentType.trim())) {
    return null;
  }
  try {
    const value: unknown = await response.json();
    return typeof value === "object" &&
      value !== null &&
      "detail" in value &&
      typeof value.detail === "string" &&
      value.detail.trim() !== ""
      ? value.detail
      : typeof value === "object" &&
          value !== null &&
          "message" in value &&
          typeof value.message === "string" &&
          value.message.trim() !== ""
        ? value.message
        : null;
  } catch {
    return null;
  }
}

function captureSubmitErrorMessage(value: unknown): string | null {
  if (
    typeof value === "object" &&
    value !== null &&
    "data" in value &&
    typeof value.data === "object" &&
    value.data !== null &&
    "errorMessage" in value.data &&
    typeof value.data.errorMessage === "string" &&
    value.data.errorMessage !== ""
  ) {
    return value.data.errorMessage;
  }
  return null;
}

function objectProperty(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null
    ? Object.getOwnPropertyDescriptor(value, name)?.value
    : undefined;
}
