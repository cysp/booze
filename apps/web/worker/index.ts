// oxlint-disable import/no-default-export -- Cloudflare Workers requires the module worker as the default export.
// oxlint-disable import/max-dependencies -- Worker composition root explicitly registers every route and workflow.

import { Hono } from "hono";
import { createD1Client } from "@chikachow/booze-db";

import { problemResponse, problemResponseForError } from "./api/http.ts";
import type { Bindings } from "./api/types.ts";
import { BottleCaptureWorkflow } from "./bottle-capture-workflow.ts";
import { startQueuedCaptureWorkflows } from "./capture-start.ts";
import { tryDrainR2ObjectDeletionQueue } from "./deletion.ts";
import { bottleCaptureRoutes } from "./routes/bottle-captures.ts";
import { healthRoutes } from "./routes/health.ts";
import { bottleRoutes } from "./routes/bottles.ts";
import { criticReviewRoutes } from "./routes/critic-reviews.ts";
import { mcpRoutes } from "./routes/mcp.ts";
import { siteRoutes } from "./routes/sites.ts";
import { storageLocationRoutes } from "./routes/storage-locations.ts";

import { wineRoutes } from "./routes/wines.ts";

const app = new Hono<{ Bindings: Bindings }>();

app.route("/", healthRoutes);
app.route("/api", healthRoutes);
app.route("/api", bottleRoutes);
app.route("/api", wineRoutes);
app.route("/api", bottleCaptureRoutes);
app.route("/api", criticReviewRoutes);
app.route("/api", siteRoutes);
app.route("/api", storageLocationRoutes);
app.route("/", mcpRoutes);

app.notFound(() => problemResponse({ status: 404, title: "Not found" }));
app.onError(problemResponseForError);

const worker = {
  fetch: app.fetch,
  scheduled(controller, env, context): void {
    context.waitUntil(
      startQueuedCaptureWorkflows({
        database: createD1Client(env.DB),
        workflow: env.BOTTLE_CAPTURE_WORKFLOW,
      }),
    );
    // Capture handoff runs every five minutes; existing object cleanup stays hourly.
    if (new Date(controller.scheduledTime).getUTCMinutes() === 0) {
      context.waitUntil(
        tryDrainR2ObjectDeletionQueue({ bucket: env.IMAGE_BUCKET, database: env.DB }),
      );
    }
  },
} satisfies ExportedHandler<Bindings>;

export default worker;
export { BottleCaptureWorkflow };
