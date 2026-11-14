import {
  bottleLocations,
  bottles,
  createD1Client,
  sites,
  storageLocations,
  type BoozeDatabase,
} from "@chikachow/booze-db";
import { and, asc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";

import { requireAuthenticatedUser } from "../api/auth.ts";
import { created, locationHeader, noContent } from "../api/http.ts";
import { readRequestJson } from "../api/request-body.ts";
import type { Bindings } from "../api/types.ts";
import {
  createStorageLocation,
  deleteStorageLocation,
  updateStorageLocation,
  createStorageLocationInputSchema,
  updateStorageLocationInputSchema,
} from "../location-operations.ts";

export const storageLocationRoutes = new Hono<{ Bindings: Bindings }>()
  .get("/storage-locations", async (context) => {
    const database = createD1Client(context.env.DB);
    const authenticatedUser = await requireAuthenticatedUser({
      database,
      request: context.req.raw,
      headers: context.req.raw.headers,
      secretKey: context.env.CLERK_SECRET_KEY,
    });
    const rows = await listStorageLocations({ database, userId: authenticatedUser.userId });
    return context.json({ data: rows });
  })
  .post("/storage-locations", async (context) => {
    const payload = createStorageLocationInputSchema.parse(await readRequestJson(context.req.raw));
    const database = createD1Client(context.env.DB);
    const authenticatedUser = await requireAuthenticatedUser({
      database,
      request: context.req.raw,
      headers: context.req.raw.headers,
      secretKey: context.env.CLERK_SECRET_KEY,
    });
    const result = await createStorageLocation({
      context: { database, userId: authenticatedUser.userId, source: "http" },
      input: payload,
    });
    return created(result.after, locationHeader(`/api/storage-locations/${result.after.id}`));
  })
  .patch("/storage-locations/:storageLocationId", async (context) => {
    const payload = updateStorageLocationInputSchema.parse(await readRequestJson(context.req.raw));
    const database = createD1Client(context.env.DB);
    const authenticatedUser = await requireAuthenticatedUser({
      database,
      request: context.req.raw,
      headers: context.req.raw.headers,
      secretKey: context.env.CLERK_SECRET_KEY,
    });
    const result = await updateStorageLocation({
      context: { database, userId: authenticatedUser.userId, source: "http" },
      storageLocationId: context.req.param("storageLocationId"),
      input: payload,
    });
    return context.json({ data: { id: result.after.id } });
  })
  .delete("/storage-locations/:storageLocationId", async (context) => {
    const database = createD1Client(context.env.DB);
    const authenticatedUser = await requireAuthenticatedUser({
      database,
      request: context.req.raw,
      headers: context.req.raw.headers,
      secretKey: context.env.CLERK_SECRET_KEY,
    });
    await deleteStorageLocation({
      context: { database, userId: authenticatedUser.userId, source: "http" },
      storageLocationId: context.req.param("storageLocationId"),
    });
    return noContent();
  });

type StorageLocationListRow = {
  readonly id: string;
  readonly siteId: string;
  readonly siteName: string;
  readonly parentId: string | null;
  readonly name: string;
  readonly locationType: string;
  readonly bottleCount: number;
};

async function listStorageLocations({
  database,
  userId,
}: {
  readonly database: BoozeDatabase;
  readonly userId: string;
}): Promise<readonly StorageLocationListRow[]> {
  const rows = await database
    .select({
      id: storageLocations.id,
      siteId: storageLocations.siteId,
      siteName: sites.name,
      parentId: storageLocations.parentId,
      name: storageLocations.name,
      locationType: storageLocations.locationType,
      bottleCount: sql<number>`count(${bottles.id})`,
    })
    .from(storageLocations)
    .innerJoin(sites, eq(storageLocations.siteId, sites.id))
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
    .where(sql`exists (
      select 1 from site_memberships
      where site_memberships.site_id = ${storageLocations.siteId}
      and site_memberships.user_id = ${userId}
    )`)
    .groupBy(
      storageLocations.id,
      storageLocations.siteId,
      sites.name,
      storageLocations.parentId,
      storageLocations.name,
      storageLocations.locationType,
    )
    .orderBy(asc(sites.name), asc(storageLocations.name));

  const byId = new Map(rows.map((row) => [row.id, row]));
  return rows.toSorted((left, right) => {
    const siteOrder = left.siteName.localeCompare(right.siteName);
    if (siteOrder !== 0) {
      return siteOrder;
    }
    return storageLocationDisplayName({ byId, locationId: left.id }).localeCompare(
      storageLocationDisplayName({ byId, locationId: right.id }),
    );
  });
}

function storageLocationDisplayName({
  byId,
  locationId,
}: {
  readonly byId: ReadonlyMap<string, StorageLocationListRow>;
  readonly locationId: string;
}): string {
  const row = byId.get(locationId);
  if (row === undefined) {
    return locationId;
  }

  const parts = [row.name];
  let parentId = row.parentId;
  const seen = new Set([row.id]);
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
