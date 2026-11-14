import { createD1Client } from "@chikachow/booze-db";
import { Hono } from "hono";
import { requireAuthenticatedUser } from "../api/auth.ts";
import { created, locationHeader, noContent } from "../api/http.ts";
import { getBottle, getCatalogueSummary, queryInventory } from "../api/inventory.ts";
import { inventoryQuerySchema } from "../api/read-query-inputs.ts";
import { readRequestJson } from "../api/request-body.ts";
import type { Bindings } from "../api/types.ts";
import {
  addBottles,
  createBottleSchema,
  deleteBottle,
  editBottle,
  patchBottleSchema,
} from "../catalogue-operations.ts";

export const bottleRoutes = new Hono<{ Bindings: Bindings }>()
  .get("/bottles", async (context) => {
    const database = createD1Client(context.env.DB);
    const { userId } = await requireAuthenticatedUser({
      database,
      request: context.req.raw,
      headers: context.req.raw.headers,
      secretKey: context.env.CLERK_SECRET_KEY,
    });
    const input = inventoryQuerySchema.parse(context.req.query());
    return context.json(await queryInventory({ database, userId, input }));
  })
  .get("/bottles/:bottleId", async (context) => {
    const database = createD1Client(context.env.DB);
    const { userId } = await requireAuthenticatedUser({
      database,
      request: context.req.raw,
      headers: context.req.raw.headers,
      secretKey: context.env.CLERK_SECRET_KEY,
    });
    return context.json({
      data: await getBottle({ database, userId, bottleId: context.req.param("bottleId") }),
    });
  })
  .get("/catalogue-summary", async (context) => {
    const database = createD1Client(context.env.DB);
    const { userId } = await requireAuthenticatedUser({
      database,
      request: context.req.raw,
      headers: context.req.raw.headers,
      secretKey: context.env.CLERK_SECRET_KEY,
    });
    return context.json({ data: await getCatalogueSummary({ database, userId }) });
  })
  .post("/bottles", async (context) => {
    const payload = createBottleSchema.parse(await readRequestJson(context.req.raw));
    const database = createD1Client(context.env.DB);
    const { userId } = await requireAuthenticatedUser({
      database,
      request: context.req.raw,
      headers: context.req.raw.headers,
      secretKey: context.env.CLERK_SECRET_KEY,
    });
    const result = await addBottles({ database, userId, source: "http" }, payload);
    return created(
      result,
      locationHeader(`/api/bottles/${encodeURIComponent(result.bottleIds[0] ?? "")}`),
    );
  })
  .patch("/bottles/:bottleId", async (context) => {
    const payload = patchBottleSchema.parse(await readRequestJson(context.req.raw));
    const database = createD1Client(context.env.DB);
    const { userId } = await requireAuthenticatedUser({
      database,
      request: context.req.raw,
      headers: context.req.raw.headers,
      secretKey: context.env.CLERK_SECRET_KEY,
    });
    const id = context.req.param("bottleId");
    await editBottle({ database, userId, source: "http" }, id, payload);
    return context.json({ data: { id } });
  })
  .delete("/bottles/:bottleId", async (context) => {
    const database = createD1Client(context.env.DB);
    const { userId } = await requireAuthenticatedUser({
      database,
      request: context.req.raw,
      headers: context.req.raw.headers,
      secretKey: context.env.CLERK_SECRET_KEY,
    });
    await deleteBottle({ database, userId, source: "http" }, context.req.param("bottleId"));
    return noContent();
  });
