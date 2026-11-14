import { z } from "zod";

export const additionOperationIdSchema = z.uuid();

// Object field order is irrelevant; array order, including capture images, is evidence.
export function canonicalAdditionInput(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => canonicalValue(entry));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalValue(entry)]),
  );
}

export async function additionFingerprint(value: unknown): Promise<string> {
  return contentDigest(new TextEncoder().encode(canonicalAdditionInput(value)));
}

export async function contentDigest(bytes: Uint8Array<ArrayBuffer> | ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
