// oxlint-disable import/max-dependencies -- Verify signed session tokens and OAuth at the HTTP and persistence boundaries.
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { env } from "node:process";
import { it } from "node:test";
import { createD1Client } from "@chikachow/booze-db";
import { Hono } from "hono";
import { requireAuthenticatedUser } from "./api/auth.ts";
import { problemResponseForError } from "./api/http.ts";
import type { Bindings } from "./api/types.ts";
import { asD1, migratedDatabase } from "./d1-support.ts";
import { mcpRoutes } from "./routes/mcp.ts";

const sessionApp = new Hono<{ Bindings: Bindings }>()
  .get("/", async (context) =>
    context.json(
      await requireAuthenticatedUser({
        database: createD1Client(context.env.DB),
        request: context.req.raw,
        headers: context.req.raw.headers,
        secretKey: context.env.CLERK_SECRET_KEY,
      }),
    ),
  )
  .onError(problemResponseForError);
const mcpApp = new Hono<{ Bindings: Bindings }>()
  .route("/", mcpRoutes)
  .onError(problemResponseForError);

await it("keeps a valid signed session's database failure distinct from invalid authentication", async (context) => {
  const sqlite = migratedDatabase();
  context.after(() => {
    sqlite.close();
  });
  const previousNodeEnv = env["NODE_ENV"];
  env["NODE_ENV"] = "test";
  context.after(() => {
    if (previousNodeEnv === undefined) delete env["NODE_ENV"];
    else env["NODE_ENV"] = previousNodeEnv;
  });
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = crypto.randomUUID();
  context.mock.method(globalThis, "fetch", async () =>
    Response.json({
      keys: [{ ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" }],
    }),
  );
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    sub: "user_auth_boundary",
    iss: "https://clerk.test",
    iat: now,
    nbf: now,
    exp: now + 300,
  };
  const unsigned = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid }))}.${base64url(JSON.stringify(claims))}`;
  const token = `${unsigned}.${sign("RSA-SHA256", new TextEncoder().encode(unsigned), privateKey).toString("base64url")}`;
  // Only the DB and authentication bindings are exercised by these routes.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- External capture bindings are irrelevant to this authentication boundary.
  const bindings = { DB: asD1(sqlite), CLERK_SECRET_KEY: `test-${kid}` } as Bindings;
  const get = async (bearer: string) =>
    sessionApp.request(
      "https://booze.test/",
      {
        headers: { authorization: `Bearer ${bearer}` },
      },
      bindings,
    );
  assert.equal((await get(token)).status, 200);
  sqlite.exec(
    "CREATE TRIGGER reject_user BEFORE INSERT ON users BEGIN SELECT RAISE(ABORT, 'database unavailable'); END",
  );
  assert.equal((await get(token)).status, 500);
  assert.equal((await get("invalid-token")).status, 401);
});

function base64url(value: string): string {
  return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replace(/[=]+$/u, "");
}

await it("keeps OAuth persistence and verification outages distinct from rejected tokens", async (context) => {
  const sqlite = migratedDatabase();
  context.after(() => {
    sqlite.close();
  });
  const database = asD1(sqlite);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The test adapter implements the session queries used by authentication.
  database.withSession = () => database as unknown as D1DatabaseSession;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This route uses no capture bindings.
  const bindings = { DB: database, CLERK_SECRET_KEY: "test-oauth" } as Bindings;
  let verificationStatus = 200;
  context.mock.method(globalThis, "fetch", async () =>
    Response.json({ subject: "oauth_user" }, { status: verificationStatus }),
  );
  const post = async () =>
    mcpApp.request(
      "https://booze.test/mcp",
      {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: "{}",
      },
      bindings,
    );
  sqlite.exec(
    "CREATE TRIGGER reject_user BEFORE INSERT ON users BEGIN SELECT RAISE(ABORT, 'database unavailable'); END",
  );
  assert.equal((await post()).status, 500);
  verificationStatus = 503;
  assert.equal((await post()).status, 503);
  verificationStatus = 401;
  assert.equal((await post()).status, 401);
  verificationStatus = 200;
  sqlite.exec("DROP TRIGGER reject_user");
  const rpc = async (body: string) =>
    mcpApp.request(
      "https://booze.test/mcp",
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body,
      },
      bindings,
    );
  assert.equal(
    (
      await rpc(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "body-boundary-test", version: "1" },
          },
        }),
      )
    ).status,
    200,
  );
  assert.equal((await rpc(JSON.stringify("a".repeat(512 * 1024)))).status, 413);
});
