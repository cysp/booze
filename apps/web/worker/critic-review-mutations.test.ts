import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createD1Client, type BoozeDatabase } from "@chikachow/booze-db";
import { Hono } from "hono";
import { z } from "zod";

import { prepareCriticReviewStatements } from "./api/critic-reviews.ts";
import { asD1, migratedDatabase } from "./d1-support.ts";
import { problemResponseForError } from "./api/http.ts";
import type { Bindings } from "./api/types.ts";
import { criticReviewRoutes } from "./routes/critic-reviews.ts";

await describe("critic review mutation preservation", async () => {
  await it("retains a concurrently created review when replacing the wine's review set", async () => {
    const { sqlite } = setup();
    const d1 = asD1(sqlite);
    const batch = d1.batch.bind(d1);
    let winnerId: unknown;
    let attempts = 0;
    d1.batch = async <T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
      attempts += 1;
      if (attempts === 1) {
        const first = await request(asD1(sqlite), "/wines/wine-one/critic-reviews", {
          siteId: "site-one",
          reviews: [{ reviewSourceId: "source-one", ratingText: "95 points" }],
        });
        assert.equal(first.status, 200, await first.clone().text());
        winnerId = sqlite
          .prepare("SELECT id FROM critic_reviews WHERE wine_vintage_id = 'wine-one'")
          .get()?.["id"];
      }
      return batch<T>(statements);
    };
    const second = await request(d1, "/wines/wine-one/critic-reviews", {
      siteId: "site-one",
      reviews: [{ reviewSourceId: "source-one", ratingText: "97 points" }],
    });
    assert.equal(second.status, 200, await second.clone().text());
    assert.equal(attempts, 2);
    const stored = sqlite
      .prepare("SELECT id, rating_text FROM critic_reviews WHERE wine_vintage_id = 'wine-one'")
      .all();
    assert.deepEqual(
      stored.map((row) => ({ ...row })),
      [{ id: winnerId, rating_text: "97 points" }],
    );
    const clear = await request(asD1(sqlite), "/wines/wine-one/critic-reviews", {
      siteId: "site-one",
      reviews: [],
    });
    assert.equal(clear.status, 200, await clear.clone().text());
    assert.deepEqual(
      sqlite
        .prepare("SELECT id, rating_text FROM critic_reviews")
        .all()
        .map((row) => ({ ...row })),
      [{ id: "unrelated-review", rating_text: "91 points" }],
    );
  });

  await it("does not overwrite a concurrent review when adding evidence with more bottles", async () => {
    const { database, sqlite } = setup();
    const [ownerEdit, bottleEvidence] = await Promise.all([
      prepareCriticReviewStatements({
        database,
        siteId: "site-one",
        userId: "user_dev-reviewer",
        wineVintageId: "wine-one",
        reviews: [
          {
            reviewSourceId: "source-one",
            ratingText: "95 points",
            provenance: "Verified guide",
            notes: "Owner checked this rating",
          },
        ],
      }),
      prepareCriticReviewStatements({
        database,
        siteId: "site-one",
        userId: "user_dev-reviewer",
        wineVintageId: "wine-one",
        overwriteExisting: false,
        removeMissing: false,
        reviews: [{ reviewSourceId: "source-one", ratingText: "85 points" }],
      }),
    ]);

    await commit(database, ownerEdit);
    const before = sqlite.prepare("SELECT * FROM critic_reviews ORDER BY id").all();
    await commit(database, bottleEvidence);
    assert.deepEqual(sqlite.prepare("SELECT * FROM critic_reviews ORDER BY id").all(), before);
  });

  await it("adds a review without replacing other facts and retains stored IDs on replacement", async () => {
    const { sqlite } = setup();
    sqlite.exec(`INSERT INTO critic_reviews
      (id, site_id, wine_vintage_id, review_source_id, rating_text, provenance)
      VALUES ('legacy-review', 'site-one', 'wine-one', 'source-one', '95 points', 'Verified guide')`);
    const added = await request(asD1(sqlite), "/critic-reviews", {
      wineVintageId: "wine-one",
      review: { reviewSourceName: "Second critic", ratingText: "Gold", provenance: "Medal list" },
    });
    assert.equal(added.status, 200, await added.clone().text());
    assert.deepEqual(
      sqlite
        .prepare(
          "SELECT id, rating_text, provenance FROM critic_reviews WHERE id = 'legacy-review'",
        )
        .all()
        .map((row) => ({ ...row })),
      [{ id: "legacy-review", rating_text: "95 points", provenance: "Verified guide" }],
    );
    const replaced = await request(asD1(sqlite), "/wines/wine-one/critic-reviews", {
      siteId: "site-one",
      reviews: [
        { reviewSourceId: "source-one", ratingText: "96 points", provenance: "Verified guide" },
      ],
    });
    assert.equal(replaced.status, 200, await replaced.clone().text());
    assert.deepEqual(
      sqlite
        .prepare("SELECT id, rating_text, provenance FROM critic_reviews ORDER BY id")
        .all()
        .map((row) => ({ ...row })),
      [
        { id: "legacy-review", rating_text: "96 points", provenance: "Verified guide" },
        { id: "unrelated-review", rating_text: "91 points", provenance: null },
      ],
    );
  });
});

await describe("complete critic review operations", async () => {
  await it("audits HTTP source and review writes, including unchanged facts with count zero", async () => {
    const { sqlite } = setup();
    const d1 = asD1(sqlite);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const source = await request(
        d1,
        "/review-sources",
        { siteId: "site-one", name: "Critic" },
        "POST",
      );
      assert.equal(source.status, 201, await source.clone().text());
      const review = await request(d1, "/critic-reviews", {
        wineVintageId: "wine-one",
        review: { reviewSourceId: "source-one", ratingText: "95 points" },
      });
      assert.equal(review.status, 200, await review.clone().text());
    }
    const audits = sqlite
      .prepare(
        "SELECT tool_name, affected_record_count, target_persisted_id, input_json FROM mcp_tool_audit_events ORDER BY rowid",
      )
      .all();
    assert.deepEqual(
      audits.map((row) => [row["tool_name"], row["affected_record_count"]]),
      [
        ["http.cellar.create_review_source", 0],
        ["http.cellar.upsert_critic_review", 1],
        ["http.cellar.create_review_source", 0],
        ["http.cellar.upsert_critic_review", 0],
      ],
    );
    for (const audit of audits)
      assert.equal(
        z.object({ source: z.string() }).parse(JSON.parse(String(audit["input_json"]))).source,
        "http",
      );
  });

  for (const operation of ["source", "upsert", "replace", "delete"] as const) {
    await it(`rejects a ${operation} after its authorizing role is downgraded before commit`, async () => {
      const { sqlite } = setup();
      seedReview(sqlite);
      const d1 = asD1(sqlite);
      const before = reviewState(sqlite);
      injectBeforeCommit(d1, () => {
        sqlite.exec(
          "UPDATE site_memberships SET role = 'viewer' WHERE user_id = 'user_dev-reviewer'",
        );
      });
      const response = await mutate(d1, operation);
      assert.equal(response.status, 403, await response.clone().text());
      assert.deepEqual(reviewState(sqlite), before);
      assert.equal(
        sqlite.prepare("SELECT count(*) AS count FROM mcp_tool_audit_events").get()?.["count"],
        0,
      );
    });

    await it(`rolls back the HTTP ${operation} when storing its audit fails`, async () => {
      const { sqlite } = setup();
      seedReview(sqlite);
      const before = reviewState(sqlite);
      sqlite.exec(
        "CREATE TRIGGER fail_audit BEFORE UPDATE ON mcp_tool_audit_events BEGIN SELECT RAISE(ABORT, 'Audit unavailable'); END",
      );
      const response = await mutate(asD1(sqlite), operation);
      assert.equal(response.status, 500, await response.clone().text());
      assert.deepEqual(reviewState(sqlite), before);
      assert.equal(
        sqlite.prepare("SELECT count(*) AS count FROM mcp_tool_audit_events").get()?.["count"],
        0,
      );
    });

    await it(`takes the ${operation} before snapshot from the committing transaction`, async () => {
      const { sqlite } = setup();
      seedReview(sqlite);
      const d1 = asD1(sqlite);
      injectBeforeCommit(d1, () => {
        sqlite.exec(
          "UPDATE review_sources SET notes = 'Concurrent source edit' WHERE id = 'source-one'; UPDATE critic_reviews SET notes = 'Concurrent review edit' WHERE id = 'review-one'",
        );
      });
      const response = await mutate(d1, operation);
      assert.ok(response.ok, await response.clone().text());
      const row = sqlite
        .prepare("SELECT before_json, after_json, affected_record_count FROM mcp_tool_audit_events")
        .get();
      assert.ok(row);
      const before: unknown = JSON.parse(String(row["before_json"]));
      if (operation === "source")
        assert.equal(z.object({ notes: z.string() }).parse(before).notes, "Concurrent source edit");
      else if (operation === "replace")
        assert.equal(
          z.object({ reviews: z.array(z.object({ notes: z.string() })).min(1) }).parse(before)
            .reviews[0]?.notes,
          "Concurrent review edit",
        );
      else
        assert.equal(z.object({ notes: z.string() }).parse(before).notes, "Concurrent review edit");
      assert.equal(row["affected_record_count"], 1);
      const after: unknown = JSON.parse(String(row["after_json"]));
      if (operation === "delete") assert.deepEqual(after, {});
      else if (operation === "source")
        assert.equal(z.object({ notes: z.string() }).parse(after).notes, "Saved source");
      else if (operation === "replace")
        assert.equal(
          z.object({ reviews: z.array(z.object({ ratingText: z.string() })).min(1) }).parse(after)
            .reviews[0]?.ratingText,
          "97 points",
        );
      else assert.equal(z.object({ ratingText: z.string() }).parse(after).ratingText, "97 points");
    });
  }

  await it("rejects a review source that becomes inactive before commit", async () => {
    const { sqlite } = setup();
    const d1 = asD1(sqlite);
    injectBeforeCommit(d1, () => {
      sqlite.exec("UPDATE review_sources SET is_active = 0 WHERE id = 'source-one'");
    });
    const response = await mutate(d1, "upsert");
    assert.equal(response.status, 400, await response.clone().text());
    assert.equal(
      sqlite
        .prepare("SELECT count(*) AS count FROM critic_reviews WHERE wine_vintage_id = 'wine-one'")
        .get()?.["count"],
      0,
    );
    assert.equal(
      sqlite.prepare("SELECT count(*) AS count FROM mcp_tool_audit_events").get()?.["count"],
      0,
    );
  });

  await it("does not classify an unrelated source constraint failure as an unavailable source", async () => {
    const { sqlite } = setup();
    sqlite.exec(
      "CREATE TRIGGER fail_audit BEFORE INSERT ON mcp_tool_audit_events BEGIN SELECT RAISE(ABORT, 'NOT NULL constraint failed: review_sources.name'); END",
    );
    const response = await mutate(asD1(sqlite), "upsert");
    assert.equal(response.status, 500, await response.clone().text());
    assert.equal(
      sqlite
        .prepare("SELECT count(*) AS count FROM critic_reviews WHERE wine_vintage_id = 'wine-one'")
        .get()?.["count"],
      0,
    );
  });

  await it("rejects source and wine site mismatches without changing evidence", async () => {
    const { sqlite } = setup();
    sqlite.exec(`INSERT INTO sites (id, name) VALUES ('site-other', 'Other cellar');
      INSERT INTO wineries (id, site_id, name) VALUES ('winery-other', 'site-other', 'Other estate');
      INSERT INTO wine_vintages (id, site_id, winery_id, base_name, display_name, vintage_label)
        VALUES ('wine-other', 'site-other', 'winery-other', 'Other', 'Other', '2020');
      INSERT INTO review_sources (id, site_id, name) VALUES ('source-other', 'site-other', 'Other critic')`);
    const before = reviewState(sqlite);
    const sourceMismatch = await request(asD1(sqlite), "/critic-reviews", {
      wineVintageId: "wine-one",
      review: { reviewSourceId: "source-other", ratingText: "100" },
    });
    assert.equal(sourceMismatch.status, 400);
    const wineMismatch = await request(asD1(sqlite), "/wines/wine-other/critic-reviews", {
      siteId: "site-one",
      reviews: [{ reviewSourceId: "source-one", ratingText: "100" }],
    });
    assert.equal(wineMismatch.status, 404);
    assert.deepEqual(reviewState(sqlite), before);
    assert.equal(
      sqlite.prepare("SELECT count(*) AS count FROM mcp_tool_audit_events").get()?.["count"],
      0,
    );
  });

  await it("counts replacements by changed review identity and audits a repeated replacement as zero", async () => {
    const { sqlite } = setup();
    seedReview(sqlite);
    const d1 = asD1(sqlite);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await request(d1, "/wines/wine-one/critic-reviews", {
        siteId: "site-one",
        reviews: [
          { reviewSourceId: "source-one", ratingText: "97 points" },
          { reviewSourceName: "Second critic", ratingText: "Gold" },
        ],
      });
      assert.equal(response.status, 200, await response.clone().text());
    }
    assert.deepEqual(
      sqlite
        .prepare("SELECT affected_record_count FROM mcp_tool_audit_events ORDER BY rowid")
        .all()
        .map((row) => row["affected_record_count"]),
      [2, 0],
    );
    assert.equal(
      sqlite
        .prepare("SELECT rating_text FROM critic_reviews WHERE id = 'unrelated-review'")
        .get()?.["rating_text"],
      "91 points",
    );
  });

  await it("rejects a review deleted before commit without inventing a successful delete audit", async () => {
    const { sqlite } = setup();
    seedReview(sqlite);
    const d1 = asD1(sqlite);
    injectBeforeCommit(d1, () => {
      sqlite.exec("DELETE FROM critic_reviews WHERE id = 'review-one'");
    });
    const response = await mutate(d1, "delete");
    assert.equal(response.status, 404, await response.clone().text());
    assert.equal(
      sqlite.prepare("SELECT count(*) AS count FROM mcp_tool_audit_events").get()?.["count"],
      0,
    );
  });
});

function injectBeforeCommit(d1: D1Database, change: () => void): void {
  let injected = false;
  const inject = () => {
    if (!injected) {
      injected = true;
      change();
    }
  };
  const batch = d1.batch.bind(d1);
  d1.batch = async <T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
    inject();
    return batch<T>(statements);
  };
  const prepare = d1.prepare.bind(d1);
  d1.prepare = (query) => {
    // The historical standalone delete never used batch. Inject before that
    // write too, so unchanged expectations exercise the old race precisely.
    if (/^delete from "critic_reviews"/iu.test(query.trim())) inject();
    return prepare(query);
  };
}

function seedReview(sqlite: ReturnType<typeof migratedDatabase>): void {
  sqlite.exec(
    "INSERT INTO critic_reviews (id, site_id, wine_vintage_id, review_source_id, rating_text, notes) VALUES ('review-one', 'site-one', 'wine-one', 'source-one', '95 points', 'Original review')",
  );
}

function reviewState(sqlite: ReturnType<typeof migratedDatabase>) {
  return {
    sources: sqlite.prepare("SELECT * FROM review_sources ORDER BY id").all(),
    reviews: sqlite.prepare("SELECT * FROM critic_reviews ORDER BY id").all(),
  };
}

async function mutate(
  d1: D1Database,
  operation: "source" | "upsert" | "replace" | "delete",
): Promise<Response> {
  if (operation === "source")
    return request(
      d1,
      "/review-sources",
      { siteId: "site-one", name: "Critic", notes: "Saved source" },
      "POST",
    );
  if (operation === "delete") return request(d1, "/critic-reviews/review-one", {}, "DELETE");
  if (operation === "replace")
    return request(d1, "/wines/wine-one/critic-reviews", {
      siteId: "site-one",
      reviews: [{ reviewSourceId: "source-one", ratingText: "97 points" }],
    });
  return request(d1, "/critic-reviews", {
    wineVintageId: "wine-one",
    review: { reviewSourceId: "source-one", ratingText: "97 points" },
  });
}

function setup() {
  const sqlite = migratedDatabase();
  sqlite.exec(`
    INSERT INTO users (id, clerk_user_id) VALUES ('user_dev-reviewer', 'dev:reviewer');
    INSERT INTO sites (id, name) VALUES ('site-one', 'Cellar');
    INSERT INTO site_memberships (site_id, user_id, role) VALUES ('site-one', 'user_dev-reviewer', 'owner');
    INSERT INTO wineries (id, site_id, name) VALUES ('winery-one', 'site-one', 'Estate');
    INSERT INTO wine_vintages (id, site_id, winery_id, base_name, display_name, vintage_label)
      VALUES ('wine-one', 'site-one', 'winery-one', 'Reserve', 'Reserve', '2020'),
             ('wine-two', 'site-one', 'winery-one', 'Reserve', 'Reserve', '2021');
    INSERT INTO review_sources (id, site_id, name) VALUES ('source-one', 'site-one', 'Critic');
    INSERT INTO critic_reviews (id, site_id, wine_vintage_id, review_source_id, rating_text)
      VALUES ('unrelated-review', 'site-one', 'wine-two', 'source-one', '91 points');
  `);
  return { database: createD1Client(asD1(sqlite)), sqlite };
}

async function commit(
  database: BoozeDatabase,
  statements: Awaited<ReturnType<typeof prepareCriticReviewStatements>>,
): Promise<void> {
  const [first, ...rest] = statements;
  assert.ok(first);
  await database.batch([first, ...rest]);
}

async function request(
  database: D1Database,
  path: string,
  payload: Record<string, unknown>,
  method = "PUT",
): Promise<Response> {
  const app = new Hono<{ Bindings: Bindings }>()
    .route("/", criticReviewRoutes)
    .onError(problemResponseForError);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Review routes use only the database binding in local authentication mode.
  const bindings = { DB: database } as Bindings;
  return app.request(
    `http://localhost${path}`,
    {
      method,
      headers: { "content-type": "application/json", "x-dev-user": "reviewer" },
      body: JSON.stringify(payload),
    },
    bindings,
  );
}
