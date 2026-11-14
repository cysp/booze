import { z } from "zod";
import { HTTPException } from "hono/http-exception";

export type PaginationInput = {
  readonly limit: number;
  readonly pageToken?: string | undefined;
  readonly [key: string]: unknown;
};

export type CursorValue = string | number | null;
export type Cursor = Record<string, CursorValue>;

export type Page<T> = {
  readonly items: readonly T[];
  readonly metadata: {
    readonly hasMore: boolean;
    readonly limit: number;
    readonly nextPageToken: string | null;
    readonly returnedCount: number;
  };
};

const cursorValueSchema = z.union([z.string(), z.number(), z.null()]);
const pageTokenSchema = z.strictObject({
  cursor: z.record(z.string(), cursorValueSchema),
  filterHash: z.string(),
  tool: z.string(),
  v: z.literal(1),
});

export function pageLimit(input: PaginationInput): number {
  return input.limit + 1;
}

export function decodePageCursor<TCursor extends Cursor>({
  cursorSchema,
  input,
  toolName,
}: {
  readonly cursorSchema: z.ZodType<TCursor>;
  readonly input: PaginationInput;
  readonly toolName: string;
}): TCursor | null {
  if (input.pageToken === undefined) {
    return null;
  }

  try {
    const token = pageTokenSchema.parse(JSON.parse(atob(input.pageToken)));
    if (token.tool !== toolName || token.filterHash !== inputFilterHash(input)) {
      throw new Error("Mismatched pageToken");
    }
    return cursorSchema.parse(token.cursor);
  } catch {
    throw new Error("Invalid pageToken");
  }
}

export function pageFromRows<TItem>({
  cursorForItem,
  input,
  items,
  toolName,
}: {
  readonly cursorForItem: (item: TItem) => Cursor;
  readonly input: PaginationInput;
  readonly items: readonly TItem[];
  readonly toolName: string;
}): Page<TItem> {
  const pageItems = items.slice(0, input.limit);
  const hasMore = items.length > input.limit;
  const finalItem = pageItems.at(-1);

  return {
    items: pageItems,
    metadata: {
      hasMore,
      limit: input.limit,
      nextPageToken:
        hasMore && finalItem !== undefined
          ? encodePageToken({
              cursor: cursorForItem(finalItem),
              filterHash: inputFilterHash(input),
              tool: toolName,
              v: 1,
            })
          : null,
      returnedCount: pageItems.length,
    },
  };
}

export function rowsAfterCursor<TItem, TCursor extends Cursor>({
  cursor,
  cursorForItem,
  items,
}: {
  readonly cursor: TCursor | null;
  readonly cursorForItem: (item: TItem) => TCursor;
  readonly items: readonly TItem[];
}): readonly TItem[] {
  if (cursor === null) {
    return items;
  }

  const cursorIndex = items.findIndex((item) => cursorsEqual(cursorForItem(item), cursor));
  if (cursorIndex === -1) {
    throw new Error("Invalid pageToken");
  }

  return items.slice(cursorIndex + 1);
}

function encodePageToken(token: z.infer<typeof pageTokenSchema>): string {
  // Escape UTF-16 code units so v1 tokens stay compatible with the existing decoder.
  const json = JSON.stringify(token).replaceAll(
    // oxlint-disable-next-line require-unicode-regexp -- Escape both halves of surrogate pairs separately.
    /[\u0080-\uFFFF]/g,
    (character) => `\\u${(character.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`,
  );
  return btoa(json);
}

function cursorsEqual(left: Cursor, right: Cursor): boolean {
  const leftEntries = Object.entries(left);
  if (leftEntries.length !== Object.keys(right).length) {
    return false;
  }

  return leftEntries.every(([key, value]) => right[key] === value);
}

function inputFilterHash(input: PaginationInput): string {
  return stableHash(canonicalJson(filterInput(input))).toString(36);
}

function filterInput(input: PaginationInput): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (key !== "limit" && key !== "pageToken" && value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function stableHash(value: string): bigint {
  let hash = 14_695_981_039_346_656_037n;
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.codePointAt(index) ?? 0;
    hash = (hash * 1_099_511_628_211n + BigInt(codePoint)) % 18_446_744_073_709_551_616n;
    if (codePoint > 0xffff) {
      index += 1;
    }
  }
  return hash;
}

export function readPaginationCursor<TCursor extends Cursor>(
  args: Parameters<typeof decodePageCursor<TCursor>>[0],
): TCursor | null {
  try {
    return decodePageCursor(args);
  } catch {
    throw new HTTPException(400, { message: "Invalid pageToken" });
  }
}
