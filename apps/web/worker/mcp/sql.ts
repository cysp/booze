import { and, or, sql, type SQL, type SQLWrapper } from "drizzle-orm";

import type { Cursor, CursorValue } from "../read-pagination.ts";

export type SortKey<TCursor extends Cursor> = {
  readonly cursorKey: keyof TCursor & string;
  readonly direction: "asc" | "desc";
  readonly expression: SQLWrapper;
};

// SQLite lower() folds ASCII only. Cursors and search inputs must use the same rules.
export function sqliteLower(value: string): string {
  return value.replaceAll(/[A-Z]/gu, (character) => character.toLowerCase());
}

export function andAll(conditions: readonly (SQL | undefined)[]): SQL | undefined {
  const present = conditions.filter((condition): condition is SQL => condition !== undefined);
  return present.length === 0 ? undefined : and(...present);
}

export function orAll(conditions: readonly (SQL | undefined)[]): SQL | undefined {
  const present = conditions.filter((condition): condition is SQL => condition !== undefined);
  return present.length === 0 ? undefined : or(...present);
}

export function optionalEquals(
  expression: SQLWrapper,
  value: CursorValue | undefined,
): SQL | undefined {
  return value === undefined ? undefined : equalsExpression(expression, value);
}

export function equalsExpression(expression: SQLWrapper, value: CursorValue): SQL {
  return value === null ? sql`${expression} is null` : sql`${expression} = ${value}`;
}

export function optionalContains(
  expression: SQLWrapper,
  value: string | undefined,
): SQL | undefined {
  return value === undefined ? undefined : containsText(expression, value);
}

export function containsText(expression: SQLWrapper, value: string): SQL {
  return sql`lower(coalesce(${expression}, '')) like ${likePattern(value)} escape '\\'`;
}

export function containsAnyText(
  value: string | undefined,
  expressions: readonly SQLWrapper[],
): SQL | undefined {
  if (value === undefined) {
    return undefined;
  }
  return orAll(expressions.map((expression) => containsText(expression, value)));
}

export { drinkStatusExpression } from "../api/inventory.ts";

export function cursorPredicate<TCursor extends Cursor>({
  cursor,
  sortKeys,
}: {
  readonly cursor: TCursor | null;
  readonly sortKeys: readonly SortKey<TCursor>[];
}): SQL | undefined {
  if (cursor === null) {
    return undefined;
  }

  const branches = sortKeys.map((sortKey, index) => {
    const previousEqualities = sortKeys
      .slice(0, index)
      .map((previous) => equalsExpression(previous.expression, cursorValue(cursor, previous)));
    const comparison = cursorComparison(sortKey, cursorValue(cursor, sortKey));
    return and(...previousEqualities, comparison);
  });

  return or(...branches);
}

function cursorComparison<TCursor extends Cursor>(
  sortKey: SortKey<TCursor>,
  value: CursorValue,
): SQL {
  return sortKey.direction === "asc"
    ? sql`${sortKey.expression} > ${value}`
    : sql`${sortKey.expression} < ${value}`;
}

function cursorValue<TCursor extends Cursor>(
  cursor: TCursor,
  sortKey: SortKey<TCursor>,
): CursorValue {
  const value = cursor[sortKey.cursorKey];
  if (value === undefined) {
    throw new Error("Invalid pageToken");
  }
  return value;
}

function likePattern(value: string): string {
  return `%${sqliteLower(value.trim())
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_")}%`;
}
