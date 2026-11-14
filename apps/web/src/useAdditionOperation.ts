import { useRef } from "react";
import { additionFingerprint, additionOperationIdSchema } from "../shared/addition-operation.ts";

type PendingAddition = { readonly fingerprint: string; readonly operationId: string };

export class PendingAdditionChangedError extends Error {
  public constructor() {
    super(
      "An earlier addition is still unconfirmed. Retry its original details or check the saved catalogue. Cancel this addition before deliberately starting another.",
    );
  }
}

// Only a digest and random ID live in this tab's session storage. Drafts and
// image bytes stay in the form. Reselecting identical photos after reload can
// reconcile an uncertain request; this is not a persistent offline upload queue.
export function useAdditionOperation(
  kind: "bottles" | "capture",
  scope: string,
): {
  readonly operationId: (siteId: string, input: unknown) => Promise<string>;
  readonly clear: (siteId: string) => void;
} {
  const pending = useRef(new Map<string, PendingAddition>());
  function storageKey(siteId: string): string {
    return `booze:addition:v1:${kind}:${encodeURIComponent(scope)}:${encodeURIComponent(siteId)}`;
  }

  async function operationId(siteId: string, input: unknown): Promise<string> {
    const key = storageKey(siteId);
    const fingerprint = await additionFingerprint(input);
    const current = pending.current.get(key) ?? readPending(key);
    if (current !== undefined && current.fingerprint !== fingerprint)
      throw new PendingAdditionChangedError();
    const value = current ?? { fingerprint, operationId: crypto.randomUUID() };
    pending.current.set(key, value);
    try {
      sessionStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* In-memory retries still work when browser storage is unavailable. */
    }
    return value.operationId;
  }

  function clear(siteId: string): void {
    const key = storageKey(siteId);
    try {
      sessionStorage.removeItem(key);
    } catch {
      /* No persistent entry is available. */
    }
    pending.current.delete(key);
  }

  return { operationId, clear };
}

function readPending(key: string): PendingAddition | undefined {
  try {
    const stored: unknown = JSON.parse(sessionStorage.getItem(key) ?? "null");
    if (
      typeof stored !== "object" ||
      stored === null ||
      !("fingerprint" in stored) ||
      !("operationId" in stored)
    )
      return undefined;
    if (typeof stored.fingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(stored.fingerprint))
      return undefined;
    const operationId = additionOperationIdSchema.safeParse(stored.operationId);
    return operationId.success
      ? { fingerprint: stored.fingerprint, operationId: operationId.data }
      : undefined;
  } catch {
    return undefined;
  }
}
