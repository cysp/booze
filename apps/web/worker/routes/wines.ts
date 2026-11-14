import { createD1Client } from "@chikachow/booze-db";
import { Hono } from "hono";
import { requireAuthenticatedUser } from "../api/auth.ts";
import { getWine, listWineOptions } from "../api/wine-options.ts";
import { wineOptionsQuerySchema } from "../api/read-query-inputs.ts";
import type { Bindings } from "../api/types.ts";

export const wineRoutes = new Hono<{ Bindings: Bindings }>()
  .get("/wines", async (context) => {
    const database = createD1Client(context.env.DB);
    const user = await requireAuthenticatedUser({
      database,
      request: context.req.raw,
      headers: context.req.raw.headers,
      secretKey: context.env.CLERK_SECRET_KEY,
    });
    return context.json(
      await listWineOptions({
        database,
        userId: user.userId,
        input: wineOptionsQuerySchema.parse(context.req.query()),
      }),
    );
  })
  .get("/wines/:wineId", async (context) => {
    const database = createD1Client(context.env.DB);
    const { userId } = await requireAuthenticatedUser({
      database,
      request: context.req.raw,
      headers: context.req.raw.headers,
      secretKey: context.env.CLERK_SECRET_KEY,
    });
    return context.json({
      data: await getWine({ database, userId, wineId: context.req.param("wineId") }),
    });
  });
