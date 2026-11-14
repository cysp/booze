// oxlint-disable import/max-dependencies -- Parity tests exercise the actual HTTP and MCP adapters against one SQL database.
import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";

import { createD1Client } from "@chikachow/booze-db";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Hono } from "hono";
import { z } from "zod";

import { asD1, migratedDatabase } from "./d1-support.ts";
import { problemResponseForError } from "./api/http.ts";
import type { Bindings } from "./api/types.ts";
import { criticReviewRoutes } from "./routes/critic-reviews.ts";
import { registerCriticReviewTools } from "./mcp/critic-reviews.ts";
import { mcpEntityId } from "./mcp/ids.ts";
import { createReviewSourceOutputSchema, upsertCriticReviewOutputSchema } from "./mcp/schemas.ts";

await describe("audited review transactions", async () => {
  await it("returns and audits the stored source when two clients create the same source", async (context) => {
    const { client, sqlite } = await setup(context, true);
    const input = { siteId: "site", name: "Critic", url: "https://critic.example" };
    const results = await Promise.all([
      client.callTool({ name: "cellar.create_review_source", arguments: input }),
      client.callTool({ name: "cellar.create_review_source", arguments: input }),
    ]);
    for (const result of results) assert.notEqual(result.isError, true, JSON.stringify(result));
    const [first, second] = results.map((result) =>
      createReviewSourceOutputSchema.parse(result.structuredContent),
    );
    assert.ok(first && second);
    assert.equal(first.reviewSource.reviewSourceId, second.reviewSource.reviewSourceId);
    assert.equal(
      sqlite.prepare("SELECT count(*) AS count FROM review_sources").get()?.["count"],
      1,
    );
    const audits = sqlite
      .prepare(`
      SELECT target_persisted_id, after_json,
        EXISTS(SELECT 1 FROM review_sources WHERE id = target_persisted_id) AS target_exists
      FROM mcp_tool_audit_events
    `)
      .all();
    assert.equal(audits.length, 2);
    for (const audit of audits) {
      assert.equal(audit["target_exists"], 1);
      const after: unknown = JSON.parse(String(audit["after_json"]));
      assert.deepEqual(after, {
        id: audit["target_persisted_id"],
        siteId: "site",
        siteName: "Cellar",
        name: "Critic",
        sourceType: "critic",
        url: "https://critic.example",
        notes: null,
        isActive: true,
      });
    }
  });

  await it("commits concurrent reviews using the winning new source and review identities", async (context) => {
    const { client, sqlite } = await setup(context, true);
    const input = {
      wineId: mcpEntityId("wine", "wine"),
      reviewSourceName: "Critic",
      ratingText: "95 points",
      provenance: "Verified guide",
    };
    const results = await Promise.all([
      client.callTool({ name: "cellar.upsert_critic_review", arguments: input }),
      client.callTool({ name: "cellar.upsert_critic_review", arguments: input }),
    ]);
    for (const result of results) assert.notEqual(result.isError, true, JSON.stringify(result));
    const [first, second] = results.map((result) =>
      upsertCriticReviewOutputSchema.parse(result.structuredContent),
    );
    assert.ok(first && second);
    assert.deepEqual(first.criticReview, second.criticReview);
    assert.equal(first.criticReview.provenance, "Verified guide");
    assert.equal(
      sqlite.prepare("SELECT count(*) AS count FROM review_sources").get()?.["count"],
      1,
    );
    assert.equal(
      sqlite.prepare("SELECT count(*) AS count FROM critic_reviews").get()?.["count"],
      1,
    );
    const audits = sqlite
      .prepare(`
      SELECT target_persisted_id, after_json,
        EXISTS(SELECT 1 FROM critic_reviews WHERE id = target_persisted_id) AS target_exists
      FROM mcp_tool_audit_events
    `)
      .all();
    assert.equal(audits.length, 2);
    for (const audit of audits) {
      assert.equal(audit["target_exists"], 1);
      const after: unknown = JSON.parse(String(audit["after_json"]));
      assert.deepEqual(after, {
        id: audit["target_persisted_id"],
        siteId: "site",
        wineVintageId: "wine",
        reviewSourceId: sqlite.prepare("SELECT id FROM review_sources").get()?.["id"],
        reviewSourceName: "Critic",
        ratingText: "95 points",
        ratingValue: null,
        ratingScale: null,
        sourceUrl: null,
        reviewedAt: null,
        provenance: "Verified guide",
        notes: null,
      });
    }
    assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
  });

  await it("keeps an existing source's identity and provenance when reviews race", async (context) => {
    const { client, sqlite } = await setup(context, true);
    sqlite.exec(`INSERT INTO review_sources (id, site_id, name, url, notes)
      VALUES ('legacy-source', 'site', 'Critic', 'https://critic.example', 'Owner verified')`);
    const input = {
      wineId: mcpEntityId("wine", "wine"),
      reviewSourceName: "Critic",
      ratingText: "95 points",
      provenance: "Verified guide",
    };
    const results = await Promise.all([
      client.callTool({ name: "cellar.upsert_critic_review", arguments: input }),
      client.callTool({ name: "cellar.upsert_critic_review", arguments: input }),
    ]);
    for (const result of results) {
      assert.notEqual(result.isError, true, JSON.stringify(result));
      const output = upsertCriticReviewOutputSchema.parse(result.structuredContent);
      assert.equal(
        output.criticReview.reviewSourceId,
        mcpEntityId("review_source", "legacy-source"),
      );
    }
    assert.deepEqual(
      { ...sqlite.prepare("SELECT id, url, notes FROM review_sources").get() },
      { id: "legacy-source", url: "https://critic.example", notes: "Owner verified" },
    );
    const audits = sqlite
      .prepare(`SELECT
      EXISTS(SELECT 1 FROM critic_reviews WHERE id = target_persisted_id) AS target_exists
      FROM mcp_tool_audit_events`)
      .all();
    assert.deepEqual(
      audits.map((row) => row["target_exists"]),
      [1, 1],
    );
    assert.equal(
      sqlite.prepare("SELECT count(*) AS count FROM critic_reviews").get()?.["count"],
      1,
    );
  });

  await it("uses the same committed facts and no-op decisions through HTTP and MCP", async (context) => {
    const { client, d1, sqlite } = await setup(context, false);
    const sourceInput = { siteId: "site", name: "Critic", url: "https://critic.example" };
    const httpSource = await httpRequest(d1, "/review-sources", "POST", sourceInput);
    assert.equal(httpSource.status, 201, await httpSource.clone().text());
    const mcpSource = await client.callTool({
      name: "cellar.create_review_source",
      arguments: sourceInput,
    });
    assert.notEqual(mcpSource.isError, true, JSON.stringify(mcpSource));
    assert.equal(createReviewSourceOutputSchema.parse(mcpSource.structuredContent).changed, false);
    const reviewInput = {
      reviewSourceName: "Critic",
      ratingText: "95 points",
      provenance: "Verified guide",
    };
    const httpReview = await httpRequest(d1, "/critic-reviews", "PUT", {
      wineVintageId: "wine",
      review: reviewInput,
    });
    assert.equal(httpReview.status, 200, await httpReview.clone().text());
    const mcpReview = await client.callTool({
      name: "cellar.upsert_critic_review",
      arguments: { wineId: mcpEntityId("wine", "wine"), ...reviewInput },
    });
    assert.notEqual(mcpReview.isError, true, JSON.stringify(mcpReview));
    assert.equal(upsertCriticReviewOutputSchema.parse(mcpReview.structuredContent).changed, false);
    const audits = sqlite
      .prepare(
        "SELECT tool_name, before_json, after_json, affected_record_count FROM mcp_tool_audit_events ORDER BY rowid",
      )
      .all();
    assert.equal(audits.length, 4);
    assert.equal(audits[0]?.["after_json"], audits[1]?.["after_json"]);
    assert.equal(audits[1]?.["before_json"], audits[1]?.["after_json"]);
    assert.equal(audits[2]?.["after_json"], audits[3]?.["after_json"]);
    assert.equal(audits[3]?.["before_json"], audits[3]?.["after_json"]);
    assert.deepEqual(
      audits.map((row) => row["affected_record_count"]),
      [1, 0, 1, 0],
    );
    assert.deepEqual(
      audits.map((row) => row["tool_name"]),
      [
        "http.cellar.create_review_source",
        "cellar.create_review_source",
        "http.cellar.upsert_critic_review",
        "cellar.upsert_critic_review",
      ],
    );
  });

  for (const toolName of [
    "cellar.create_review_source",
    "cellar.upsert_critic_review",
    "cellar.delete_critic_review",
  ]) {
    await it(`rejects a permission downgrade before ${toolName} commits`, async (context) => {
      const { client, d1, sqlite } = await setup(context, false);
      sqlite.exec(
        "INSERT INTO review_sources (id, site_id, name) VALUES ('source', 'site', 'Critic'); INSERT INTO critic_reviews (id, site_id, wine_vintage_id, review_source_id, rating_text) VALUES ('review', 'site', 'wine', 'source', '95 points')",
      );
      const before = sqlite.prepare("SELECT * FROM critic_reviews").all();
      const batch = d1.batch.bind(d1);
      d1.batch = async <T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
        sqlite.exec("UPDATE site_memberships SET role = 'viewer'");
        return batch<T>(statements);
      };
      const input =
        toolName === "cellar.create_review_source"
          ? { siteId: "site", name: "Critic", notes: "Changed" }
          : toolName === "cellar.upsert_critic_review"
            ? {
                wineId: mcpEntityId("wine", "wine"),
                reviewSourceName: "Critic",
                ratingText: "97 points",
              }
            : { criticReviewId: mcpEntityId("critic_review", "review") };
      const result = await client.callTool({ name: toolName, arguments: input });
      assert.equal(result.isError, true);
      assert.deepEqual(sqlite.prepare("SELECT * FROM critic_reviews").all(), before);
      assert.equal(sqlite.prepare("SELECT notes FROM review_sources").get()?.["notes"], null);
      assert.equal(
        sqlite.prepare("SELECT count(*) AS count FROM mcp_tool_audit_events").get()?.["count"],
        0,
      );
    });
  }

  for (const toolName of [
    "cellar.create_review_source",
    "cellar.upsert_critic_review",
    "cellar.delete_critic_review",
  ]) {
    await it(`audits the actual concurrent before facts for ${toolName}`, async (context) => {
      const { client, d1, sqlite } = await setup(context, false);
      sqlite.exec(
        "INSERT INTO review_sources (id, site_id, name, notes) VALUES ('source', 'site', 'Critic', 'Original source'); INSERT INTO critic_reviews (id, site_id, wine_vintage_id, review_source_id, rating_text, notes) VALUES ('review', 'site', 'wine', 'source', '95 points', 'Original review')",
      );
      const batch = d1.batch.bind(d1);
      d1.batch = async <T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
        sqlite.exec(
          "UPDATE review_sources SET notes = 'Concurrent source' WHERE id = 'source'; UPDATE critic_reviews SET notes = 'Concurrent review' WHERE id = 'review'",
        );
        return batch<T>(statements);
      };
      const input =
        toolName === "cellar.create_review_source"
          ? { siteId: "site", name: "Critic", notes: "Saved source" }
          : toolName === "cellar.upsert_critic_review"
            ? {
                wineId: mcpEntityId("wine", "wine"),
                reviewSourceName: "Critic",
                ratingText: "97 points",
              }
            : { criticReviewId: mcpEntityId("critic_review", "review") };
      const result = await client.callTool({ name: toolName, arguments: input });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      const event = sqlite
        .prepare("SELECT before_json, after_json FROM mcp_tool_audit_events")
        .get();
      const before = z
        .object({ notes: z.string() })
        .parse(JSON.parse(String(event?.["before_json"])));
      assert.equal(
        before.notes,
        toolName === "cellar.create_review_source" ? "Concurrent source" : "Concurrent review",
      );
      if (toolName === "cellar.delete_critic_review") assert.equal(event?.["after_json"], "{}");
    });
  }

  for (const toolName of ["cellar.create_review_source", "cellar.upsert_critic_review"]) {
    await it(`does not replay ${toolName} after a lost commit acknowledgement`, async (context) => {
      const { client, d1, sqlite } = await setup(context, false);
      const batch = d1.batch.bind(d1);
      let attempts = 0;
      d1.batch = async (statements) => {
        attempts += 1;
        await batch(statements);
        throw new Error("Response lost after commit");
      };
      const input =
        toolName === "cellar.create_review_source"
          ? { siteId: "site", name: "Critic" }
          : {
              wineId: mcpEntityId("wine", "wine"),
              reviewSourceName: "Critic",
              ratingText: "95 points",
            };
      const result = await client.callTool({ name: toolName, arguments: input });
      assert.equal(result.isError, true);
      assert.equal(attempts, 1);
      assert.equal(
        sqlite.prepare("SELECT count(*) AS count FROM review_sources").get()?.["count"],
        1,
      );
      assert.equal(
        sqlite.prepare("SELECT count(*) AS count FROM mcp_tool_audit_events").get()?.["count"],
        1,
      );
    });

    await it(`rolls back ${toolName} when its audit cannot be stored`, async (context) => {
      const { client, sqlite } = await setup(context, false);
      sqlite.exec(
        "CREATE TRIGGER fail_audit BEFORE UPDATE ON mcp_tool_audit_events BEGIN SELECT RAISE(ABORT, 'Audit unavailable'); END",
      );
      const input =
        toolName === "cellar.create_review_source"
          ? { siteId: "site", name: "Critic" }
          : {
              wineId: mcpEntityId("wine", "wine"),
              reviewSourceName: "Critic",
              ratingText: "95 points",
            };
      const result = await client.callTool({ name: toolName, arguments: input });
      assert.equal(result.isError, true);
      for (const table of ["review_sources", "critic_reviews", "mcp_tool_audit_events"]) {
        assert.equal(sqlite.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.["count"], 0);
      }
    });
  }

  await it("returns the committed review without a post-commit database read", async (context) => {
    const { client, d1, sqlite } = await setup(context, false);
    const batch = d1.batch.bind(d1);
    let attempts = 0;
    d1.batch = async <T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
      attempts += 1;
      const result = await batch<T>(statements);
      d1.prepare = () => {
        throw new Error(
          "UNIQUE constraint failed: critic_reviews.site_id, critic_reviews.wine_vintage_id, critic_reviews.review_source_id",
        );
      };
      return result;
    };
    const result = await client.callTool({
      name: "cellar.upsert_critic_review",
      arguments: {
        wineId: mcpEntityId("wine", "wine"),
        reviewSourceName: "Critic",
        ratingText: "95 points",
      },
    });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.equal(attempts, 1);
    assert.equal(
      sqlite.prepare("SELECT count(*) AS count FROM critic_reviews").get()?.["count"],
      1,
    );
    assert.equal(
      sqlite.prepare("SELECT count(*) AS count FROM mcp_tool_audit_events").get()?.["count"],
      1,
    );
  });
});

async function setup(context: TestContext, concurrent: boolean) {
  const sqlite = migratedDatabase();
  sqlite.exec(`
    INSERT INTO users (id, clerk_user_id) VALUES ('user_dev-reviewer', 'dev:reviewer');
    INSERT INTO sites (id, name) VALUES ('site', 'Cellar');
    INSERT INTO site_memberships (site_id, user_id, role) VALUES ('site', 'user_dev-reviewer', 'owner');
    INSERT INTO wineries (id, site_id, name) VALUES ('winery', 'site', 'Estate');
    INSERT INTO wine_vintages (id, site_id, winery_id, base_name, display_name, vintage_label)
      VALUES ('wine', 'site', 'winery', 'Reserve', 'Reserve', '2020');
  `);
  const d1 = asD1(sqlite);
  if (concurrent) overlapFirstTwoBatches(d1);
  const server = new McpServer({ name: "review-test", version: "1" });
  const annotations = {
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
    readOnlyHint: false,
  };
  registerCriticReviewTools({
    database: createD1Client(d1),
    readOnlyToolAnnotations: { ...annotations, readOnlyHint: true },
    server,
    userId: "user_dev-reviewer",
    writeToolAnnotations: annotations,
  });
  const client = new Client({ name: "review-test-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  context.after(async () => {
    await client.close();
    await server.close();
    sqlite.close();
  });
  return { client, d1, sqlite };
}

function overlapFirstTwoBatches(d1: D1Database): void {
  const batch = d1.batch.bind(d1);
  const ready = Promise.withResolvers<null>();
  let attempts = 0;
  let committed = Promise.resolve(null);
  d1.batch = async <T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
    attempts += 1;
    if (attempts <= 2) {
      if (attempts === 2) ready.resolve(null);
      await ready.promise;
    }
    const previous = committed;
    const complete = Promise.withResolvers<null>();
    committed = complete.promise;
    await previous;
    try {
      return await batch<T>(statements);
    } finally {
      complete.resolve(null);
    }
  };
}

async function httpRequest(
  database: D1Database,
  path: string,
  method: string,
  payload: Record<string, unknown>,
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
