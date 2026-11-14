import {
  bottleLocations,
  bottles,
  siteMemberships,
  sites,
  storageLocations,
  type createD1Client,
} from "@chikachow/booze-db";
import { and, asc, eq, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import { decodePageCursor, pageFromRows, pageLimit, type Page } from "./pagination.ts";
import type { listStorageLocationsInputSchema, storageLocationSummarySchema } from "./schemas.ts";
import { andAll, containsAnyText, cursorPredicate, optionalEquals, sqliteLower } from "./sql.ts";

const listStorageLocationsToolName = "cellar.list_storage_locations";
const listStorageLocationsCursorSchema = z.strictObject({
  location: z.string(),
  locationId: z.string(),
  site: z.string(),
});

export async function listStorageLocationDisplayNames({
  database,
  userId,
}: {
  readonly database: ReturnType<typeof createD1Client>;
  readonly userId: string;
}): Promise<ReadonlyMap<string, string>> {
  const rows = await database
    .select({
      id: storageLocations.id,
      name: storageLocations.name,
      parentId: storageLocations.parentId,
    })
    .from(storageLocations)
    .innerJoin(siteMemberships, eq(storageLocations.siteId, siteMemberships.siteId))
    .where(eq(siteMemberships.userId, userId));

  const byId = new Map(rows.map((row) => [row.id, row]));
  const displayNames = new Map<string, string>();
  for (const row of rows) {
    displayNames.set(row.id, storageLocationDisplayName({ byId, locationId: row.id }));
  }
  return displayNames;
}

export async function listStorageLocations({
  database,
  input,
  userId,
}: {
  readonly database: ReturnType<typeof createD1Client>;
  readonly input: z.infer<typeof listStorageLocationsInputSchema>;
  readonly userId: string;
}): Promise<Page<z.infer<typeof storageLocationSummarySchema>>> {
  const siteSort = sql<string>`lower(${sites.name})`;
  const locationSort = sql<string>`lower(${storageLocations.name})`;
  const cursor = decodePageCursor({
    cursorSchema: listStorageLocationsCursorSchema,
    input,
    toolName: listStorageLocationsToolName,
  });
  const rows = await database
    .select({
      id: storageLocations.id,
      siteId: storageLocations.siteId,
      siteName: sites.name,
      parentId: storageLocations.parentId,
      locationName: storageLocations.name,
      locationType: storageLocations.locationType,
      bottleCount: sql<number>`count(${bottles.id})`,
    })
    .from(storageLocations)
    .innerJoin(sites, eq(storageLocations.siteId, sites.id))
    .innerJoin(siteMemberships, eq(storageLocations.siteId, siteMemberships.siteId))
    .leftJoin(
      bottleLocations,
      and(
        eq(storageLocations.siteId, bottleLocations.siteId),
        eq(storageLocations.id, bottleLocations.storageLocationId),
      ),
    )
    .leftJoin(
      bottles,
      and(eq(bottleLocations.bottleId, bottles.id), eq(bottles.status, "in_stock")),
    )
    .where(
      andAll([
        eq(siteMemberships.userId, userId),
        optionalEquals(storageLocations.siteId, input.siteId),
        containsAnyText(input.query, [
          sites.name,
          storageLocations.name,
          storageLocations.locationType,
        ]),
        cursorPredicate({
          cursor,
          sortKeys: [
            { cursorKey: "site", direction: "asc", expression: siteSort },
            { cursorKey: "location", direction: "asc", expression: locationSort },
            { cursorKey: "locationId", direction: "asc", expression: storageLocations.id },
          ],
        }),
      ]),
    )
    .groupBy(
      storageLocations.id,
      storageLocations.siteId,
      sites.name,
      storageLocations.parentId,
      storageLocations.name,
      storageLocations.locationType,
    )
    .orderBy(asc(siteSort), asc(locationSort), asc(storageLocations.id))
    .limit(pageLimit(input));

  const rowPage = pageFromRows({
    cursorForItem: (row) => ({
      location: sqliteLower(row.locationName),
      locationId: row.id,
      site: sqliteLower(row.siteName),
    }),
    input,
    items: rows,
    toolName: listStorageLocationsToolName,
  });
  const displayNames = await listStorageLocationDisplayNames({ database, userId });
  return {
    items: rowPage.items.map((row) => storageLocationSummaryFromRow({ displayNames, row })),
    metadata: rowPage.metadata,
  };
}

export async function resolveStorageLocationId({
  database,
  locationId,
  userId,
}: {
  readonly database: ReturnType<typeof createD1Client>;
  readonly locationId: string;
  readonly userId: string;
}): Promise<string> {
  const [row] = await database
    .select({ id: storageLocations.id })
    .from(storageLocations)
    .innerJoin(siteMemberships, eq(storageLocations.siteId, siteMemberships.siteId))
    .where(and(eq(siteMemberships.userId, userId), eq(storageLocations.id, locationId)))
    .limit(1);
  if (row === undefined) {
    throw new HTTPException(404, { message: "Storage location not found" });
  }
  return row.id;
}

function storageLocationSummaryFromRow({
  displayNames,
  row,
}: {
  readonly displayNames: ReadonlyMap<string, string>;
  readonly row: {
    readonly bottleCount: number;
    readonly id: string;
    readonly locationName: string;
    readonly locationType: string;
    readonly parentId: string | null;
    readonly siteId: string;
    readonly siteName: string;
  };
}): z.infer<typeof storageLocationSummarySchema> {
  return {
    bottleCount: row.bottleCount,
    parentStorageLocationId: row.parentId,
    site: row.siteName,
    siteId: row.siteId,
    storageLocation: displayNames.get(row.id) ?? row.locationName,
    storageLocationId: row.id,
    storageLocationType: row.locationType,
  };
}

function storageLocationDisplayName({
  byId,
  locationId,
}: {
  readonly byId: ReadonlyMap<
    string,
    { readonly id: string; readonly name: string; readonly parentId: string | null }
  >;
  readonly locationId: string;
}): string {
  const row = byId.get(locationId);
  if (row === undefined) {
    return locationId;
  }

  const parts = [row.name];
  const seen = new Set([row.id]);
  let parentId = row.parentId;

  while (parentId !== null && !seen.has(parentId)) {
    const parent = byId.get(parentId);
    if (parent === undefined) {
      break;
    }
    parts.unshift(parent.name);
    seen.add(parent.id);
    parentId = parent.parentId;
  }

  return parts.join(" / ");
}
