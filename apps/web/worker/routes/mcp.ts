import { createD1SessionClient } from "@chikachow/booze-db";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import { ensureAuthenticatedClerkUser } from "../api/auth.ts";
import { readRequestBytes } from "../api/request-body.ts";
import type { Bindings, AuthenticatedUser } from "../api/types.ts";
import { createBoozeMcpServer } from "../mcp/server.ts";

const CLERK_OAUTH_TOKEN_VERIFY_URL =
  "https://api.clerk.com/v1/oauth_applications/access_tokens/verify";
const CLERK_OAUTH_SCOPES = ["email", "offline_access", "openid", "profile"] as const;
const CLERK_OAUTH_SCOPE = CLERK_OAUTH_SCOPES.join(" ");

export const mcpRoutes = new Hono<{ Bindings: Bindings }>()
  .get("/.well-known/oauth-protected-resource", (context) => {
    const metadata = protectedResourceMetadata({
      issuer: context.env.CLERK_OAUTH_ISSUER,
      requestUrl: new URL(context.req.url),
    });
    return context.json(metadata);
  })
  .options("/mcp", () => new Response(null, { headers: mcpCorsHeaders(), status: 204 }))
  .all("/mcp", async (context) => {
    const requestUrl = new URL(context.req.url);
    const database = createD1SessionClient(context.env.DB.withSession("first-primary"));
    const authenticatedUser = await authenticateMcpUser({
      database,
      headers: context.req.raw.headers,
      request: context.req.raw,
      secretKey: context.env.CLERK_SECRET_KEY,
    });

    if (authenticatedUser === null) {
      return unauthorizedMcpResponse(requestUrl);
    }

    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    const server = createBoozeMcpServer({
      database,
      userId: authenticatedUser.userId,
    });
    await server.connect(transport);
    const request =
      context.req.raw.body === null
        ? context.req.raw
        : new Request(context.req.raw, {
            method: context.req.method,
            body: (await readRequestBytes(context.req.raw)).buffer,
          });
    const response = await transport.handleRequest(request);
    return addMcpHeaders(response);
  });

async function authenticateMcpUser({
  database,
  headers,
  request,
  secretKey,
}: {
  readonly database: ReturnType<typeof createD1SessionClient>;
  readonly headers: Headers;
  readonly request: Request;
  readonly secretKey: string | undefined;
}): Promise<AuthenticatedUser | null> {
  const devUser = headers.get("x-dev-user");
  const isLocalhost =
    new URL(request.url).hostname === "localhost" || new URL(request.url).hostname === "127.0.0.1";

  if (
    (secretKey === undefined || secretKey === "") &&
    isLocalhost &&
    devUser !== null &&
    devUser !== ""
  ) {
    return ensureAuthenticatedClerkUser({ database, clerkUserId: `dev:${devUser}` });
  }

  if (secretKey === undefined || secretKey === "") {
    throw new HTTPException(503, { message: "Clerk is not configured" });
  }

  const token = bearerToken(headers);
  if (token === null) {
    return null;
  }

  const accessToken = await verifyClerkOAuthAccessToken({ secretKey, token });
  return accessToken === null
    ? null
    : ensureAuthenticatedClerkUser({ database, clerkUserId: accessToken.clerkUserId });
}

async function verifyClerkOAuthAccessToken({
  secretKey,
  token,
}: {
  readonly secretKey: string;
  readonly token: string;
}): Promise<{ readonly clerkUserId: string } | null> {
  let response: Response;
  let body: unknown;
  try {
    response = await fetch(CLERK_OAUTH_TOKEN_VERIFY_URL, {
      body: JSON.stringify({ access_token: token }),
      headers: {
        authorization: `Bearer ${secretKey}`,
        "content-type": "application/json",
      },
      method: "POST",
    });
    if ([400, 401, 403].includes(response.status)) return null;
    if (!response.ok) throw new Error("Token verification service failed");
    body = await response.json();
  } catch (cause) {
    throw new HTTPException(503, { cause, message: "Authentication service unavailable" });
  }
  const clerkUserId = clerkOAuthSubject(body);
  if (clerkUserId === null) {
    return null;
  }
  return { clerkUserId };
}

export function clerkOAuthSubject(body: unknown): string | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }

  if ("subject" in body && typeof body.subject === "string" && body.subject !== "") {
    return body.subject;
  }

  if ("sub" in body && typeof body.sub === "string" && body.sub !== "") {
    return body.sub;
  }

  if ("user_id" in body && typeof body.user_id === "string" && body.user_id !== "") {
    return body.user_id;
  }

  return null;
}

export function clerkOAuthScopes(body: unknown): ReadonlySet<string> {
  if (typeof body !== "object" || body === null) {
    return new Set();
  }

  if ("scopes" in body && Array.isArray(body.scopes)) {
    return new Set(body.scopes.filter((scope): scope is string => typeof scope === "string"));
  }

  if ("scope" in body && typeof body.scope === "string") {
    return new Set(body.scope.split(/\s+/u).filter((scope) => scope !== ""));
  }

  return new Set();
}

function protectedResourceMetadata({
  issuer,
  requestUrl,
}: {
  readonly issuer: string | undefined;
  readonly requestUrl: URL;
}): Record<string, unknown> {
  if (issuer === undefined || issuer.trim() === "") {
    throw new HTTPException(503, { message: "CLERK_OAUTH_ISSUER is not configured" });
  }

  return {
    resource: `${requestUrl.origin}/mcp`,
    resource_name: "Booze MCP",
    authorization_servers: [issuer.trim().replace(/\/+$/u, "")],
    bearer_methods_supported: ["header"],
    scopes_supported: [...CLERK_OAUTH_SCOPES],
  };
}

function unauthorizedMcpResponse(requestUrl: URL): Response {
  return new Response("Authentication required", {
    headers: {
      ...mcpCorsHeaders(),
      "www-authenticate": `Bearer resource_metadata="${requestUrl.origin}/.well-known/oauth-protected-resource", scope="${CLERK_OAUTH_SCOPE}"`,
    },
    status: 401,
  });
}

function addMcpHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(mcpCorsHeaders())) {
    headers.set(name, value);
  }
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

function mcpCorsHeaders(): Record<string, string> {
  return {
    "access-control-allow-headers":
      "Authorization, Content-Type, Last-Event-ID, mcp-protocol-version, mcp-session-id, x-dev-user",
    "access-control-allow-methods": "DELETE, GET, OPTIONS, POST",
    "access-control-allow-origin": "*",
    "access-control-expose-headers": "mcp-protocol-version, mcp-session-id, WWW-Authenticate",
  };
}

function bearerToken(headers: Headers): string | null {
  const authorizationHeader = headers.get("authorization");
  const token =
    authorizationHeader !== null && authorizationHeader.startsWith("Bearer ")
      ? authorizationHeader.slice("Bearer ".length)
      : null;
  return token === null || token === "" ? null : token;
}
