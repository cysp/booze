import {
  bottles,
  createD1Client,
  siteMemberships,
  sites,
  storageLocations,
  type BoozeDatabase,
} from "@chikachow/booze-db";
import { asc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import { requireAuthenticatedUser, requireSitePermission, upsertSite } from "../api/auth.ts";
import { created, locationHeader, noContent } from "../api/http.ts";
import { readRequestJson } from "../api/request-body.ts";
import type { Bindings } from "../api/types.ts";
import { deleteSiteData, tryDrainR2ObjectDeletionQueue } from "../deletion.ts";

const createSiteSchema = z.object({
  name: z.string().trim().min(1).max(80),
});

const updateSiteSchema = z.object({
  name: z.string().trim().min(1).max(80),
});

export const siteRoutes = new Hono<{ Bindings: Bindings }>()
  .get("/sites", async (context) => {
    const database = createD1Client(context.env.DB);
    const authenticatedUser = await requireAuthenticatedUser({
      database,
      request: context.req.raw,
      headers: context.req.raw.headers,
      secretKey: context.env.CLERK_SECRET_KEY,
    });

    const rows = await listSites({ database, userId: authenticatedUser.userId });
    return context.json({ data: rows });
  })
  .post("/sites", async (context) => {
    const payload = createSiteSchema.parse(await readRequestJson(context.req.raw));
    const database = createD1Client(context.env.DB);
    const authenticatedUser = await requireAuthenticatedUser({
      database,
      request: context.req.raw,
      headers: context.req.raw.headers,
      secretKey: context.env.CLERK_SECRET_KEY,
    });

    const result = await upsertSite({
      database,
      site: payload.name,
      userId: authenticatedUser.userId,
    });

    return created(
      { id: result.siteId, name: payload.name },
      locationHeader(`/api/sites/${result.siteId}`),
    );
  })
  .patch("/sites/:siteId", async (context) => {
    const payload = updateSiteSchema.parse(await readRequestJson(context.req.raw));
    const database = createD1Client(context.env.DB);
    const authenticatedUser = await requireAuthenticatedUser({
      database,
      request: context.req.raw,
      headers: context.req.raw.headers,
      secretKey: context.env.CLERK_SECRET_KEY,
    });
    const siteId = context.req.param("siteId");

    await requireSitePermission({
      database,
      permission: "site.manage",
      siteId,
      userId: authenticatedUser.userId,
    });
    await database
      .update(sites)
      .set({ name: payload.name, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(sites.id, siteId));

    return context.json({ data: { id: siteId, name: payload.name } });
  })
  .delete("/sites/:siteId", async (context) => {
    const database = createD1Client(context.env.DB);
    const authenticatedUser = await requireAuthenticatedUser({
      database,
      request: context.req.raw,
      headers: context.req.raw.headers,
      secretKey: context.env.CLERK_SECRET_KEY,
    });
    const siteId = context.req.param("siteId");

    await requireSitePermission({
      database,
      permission: "site.manage",
      siteId,
      userId: authenticatedUser.userId,
    });
    if (!(await deleteSiteData({ database: context.env.DB, siteId }))) {
      throw new HTTPException(409, {
        message: "Wait for capture processing to finish before deleting this site",
      });
    }
    await tryDrainR2ObjectDeletionQueue({
      bucket: context.env.IMAGE_BUCKET,
      database: context.env.DB,
    });

    return noContent();
  });

async function listSites({
  database,
  userId,
}: {
  readonly database: BoozeDatabase;
  readonly userId: string;
}): Promise<
  readonly {
    readonly id: string;
    readonly name: string;
    readonly bottleCount: number;
    readonly locationCount: number;
    readonly role: string;
  }[]
> {
  const bottleCountsBySite = database
    .select({
      siteId: bottles.siteId,
      bottleCount: sql<number>`count(${bottles.id})`.as("bottle_count"),
    })
    .from(bottles)
    .where(eq(bottles.status, "in_stock"))
    .groupBy(bottles.siteId)
    .as("bottle_counts_by_site");
  const locationCountsBySite = database
    .select({
      siteId: storageLocations.siteId,
      locationCount: sql<number>`count(${storageLocations.id})`.as("location_count"),
    })
    .from(storageLocations)
    .groupBy(storageLocations.siteId)
    .as("location_counts_by_site");

  const rows = await database
    .select({
      id: sites.id,
      name: sites.name,
      bottleCount: sql<number>`coalesce(${bottleCountsBySite.bottleCount}, 0)`,
      locationCount: sql<number>`coalesce(${locationCountsBySite.locationCount}, 0)`,
      role: siteMemberships.role,
    })
    .from(sites)
    .innerJoin(siteMemberships, eq(sites.id, siteMemberships.siteId))
    .leftJoin(bottleCountsBySite, eq(sites.id, bottleCountsBySite.siteId))
    .leftJoin(locationCountsBySite, eq(sites.id, locationCountsBySite.siteId))
    .where(eq(siteMemberships.userId, userId))
    .orderBy(asc(sites.name));

  if (!Array.isArray(rows)) {
    throw new HTTPException(500, { message: "Could not list sites" });
  }
  return rows;
}
