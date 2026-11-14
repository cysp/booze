import assert from "node:assert/strict";
import { it } from "node:test";
import { Hono } from "hono";
import { z } from "zod";
import { userIdForClerkUser } from "./api/ids.ts";
import { problemResponseForError } from "./api/http.ts";
import type { Bindings } from "./api/types.ts";
import { asD1, migratedDatabase } from "./d1-support.ts";
import { bottleRoutes } from "./routes/bottles.ts";
import { criticReviewRoutes } from "./routes/critic-reviews.ts";

await it("round-trips opaque stored identifiers through HTTP evidence queries and mutations", async (context) => {
  const sqlite = migratedDatabase();
  context.after(() => {
    sqlite.close();
  });
  const userId = userIdForClerkUser("dev:tester");
  const siteId = " site / 旧 cellar ";
  const wineId = " wine / #?🍷 ";
  const bottleId = " bottle / #?🍷 ";
  const sourceId = " source / #?🍷 ";
  const reviewId = " review / #?🍷 ";
  const awardId = ` award ${"legacy-".repeat(24)} `;
  sqlite.prepare("INSERT INTO users(id,clerk_user_id) VALUES (?,'dev:tester')").run(userId);
  sqlite.prepare("INSERT INTO sites(id,name) VALUES (?,'Cellar')").run(siteId);
  sqlite
    .prepare("INSERT INTO site_memberships(site_id,user_id,role) VALUES (?,?,'owner')")
    .run(siteId, userId);
  sqlite
    .prepare(
      "INSERT INTO wine_vintages(id,site_id,base_name,display_name,vintage_label) VALUES (?,?,'Wine','Wine','Unknown')",
    )
    .run(wineId, siteId);
  sqlite
    .prepare("INSERT INTO bottles(id,site_id,wine_vintage_id) VALUES (?,?,?)")
    .run(bottleId, siteId, wineId);
  sqlite
    .prepare("INSERT INTO review_sources(id,site_id,name) VALUES (?,?,'Critic')")
    .run(sourceId, siteId);
  sqlite
    .prepare(
      "INSERT INTO critic_reviews(id,site_id,wine_vintage_id,review_source_id,rating_text) VALUES (?,?,?,?,'90')",
    )
    .run(reviewId, siteId, wineId, sourceId);
  sqlite
    .prepare(
      "INSERT INTO wine_awards(id,site_id,wine_vintage_id,award_name,award_level) VALUES (?,?,?,'Show','Gold')",
    )
    .run(awardId, siteId, wineId);
  const app = new Hono<{ Bindings: Bindings }>()
    .route("/", bottleRoutes)
    .route("/", criticReviewRoutes)
    .onError(problemResponseForError);
  const request = async (path: string, method = "GET", body?: unknown) =>
    app.request(
      `http://localhost${path}`,
      {
        method,
        headers: { "x-dev-user": "tester", "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      { DB: asD1(sqlite) },
    );
  const idsSchema = z.object({ data: z.array(z.object({ id: z.string() })) });
  const sources = await request(`/review-sources?${new URLSearchParams({ siteId })}`);
  assert.equal(sources.status, 200);
  assert.deepEqual(
    idsSchema.parse(await sources.json()).data.map((item) => item.id),
    [sourceId],
  );
  const reviews = await request(
    `/critic-reviews?${new URLSearchParams({ wineVintageId: wineId })}`,
  );
  assert.equal(reviews.status, 200);
  assert.deepEqual(
    idsSchema.parse(await reviews.json()).data.map((item) => item.id),
    [reviewId],
  );
  const changed = await request("/critic-reviews", "PUT", {
    wineVintageId: wineId,
    review: { id: reviewId, reviewSourceId: sourceId, ratingText: "95" },
  });
  assert.equal(changed.status, 200, await changed.text());
  assert.equal(
    sqlite.prepare("SELECT rating_text FROM critic_reviews WHERE id=?").get(reviewId)?.[
      "rating_text"
    ],
    "95",
  );
  const awardEdit = await request(`/bottles/${encodeURIComponent(bottleId)}`, "PATCH", {
    wineEditScope: "shared",
    expectedWineVintageId: wineId,
    expectedAffectedBottleCount: 1,
    awards: [{ id: awardId, awardName: "Show", awardLevel: "Gold", notes: "Retained evidence" }],
  });
  assert.equal(awardEdit.status, 200, await awardEdit.text());
  assert.equal(
    sqlite.prepare("SELECT notes FROM wine_awards WHERE id=?").get(awardId)?.["notes"],
    "Retained evidence",
  );
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM wine_awards").get()?.["count"], 1);
});
