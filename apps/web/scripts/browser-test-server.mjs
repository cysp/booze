// oxlint-disable node/no-top-level-await -- Playwright executes this ESM entrypoint directly.
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { json } from "node:stream/consumers";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { labelExtractionFixture } from "../test/label-extraction.ts";

const directory = process.env.BOOZE_BROWSER_TEST_STATE;
if (
  directory === undefined ||
  path.dirname(directory) !== tmpdir() ||
  !/^booze-playwright-[\da-f-]+$/u.test(path.basename(directory))
) {
  throw new Error("Playwright must supply its own temporary browser-test directory");
}

// Do not inherit Clerk, Cloudflare, or model credentials from the invoking shell.
const environment = Object.fromEntries(
  ["PATH", "TMPDIR", "TMP", "TEMP"].flatMap((key) =>
    process.env[key] === undefined ? [] : [[key, process.env[key]]],
  ),
);
process.env = {
  ...environment,
  BOOZE_BROWSER_TEST_STATE: directory,
  CI: "true",
  CLOUDFLARE_ENV: "",
  CLOUDFLARE_INCLUDE_PROCESS_ENV: "false",
  CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
  VITE_AUTH_MODE: "development",
  WRANGLER_SEND_METRICS: "false",
  WRANGLER_WRITE_LOGS: "false",
};

mkdirSync(directory);
// Vite's own SIGTERM handler may exit after closing, before our await resumes.
process.once("exit", () => {
  rmSync(directory, { force: true, recursive: true });
});
/** @type {import("vite").ViteDevServer | undefined} */
let server;
/** @type {Promise<void> | undefined} */
let closing;
const close = async () => {
  closing ??= (async () => {
    try {
      await server?.close();
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  })();
  return closing;
};
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void stop();
  });
}

async function stop() {
  try {
    await close();
  } finally {
    // oxlint-disable-next-line unicorn/no-process-exit -- End the server entrypoint after its owned resources have closed.
    process.exit(0);
  }
}

const gatewayPrompt = z.object({
  messages: z.array(
    z.object({ role: z.string(), content: z.union([z.string(), z.array(z.unknown())]) }),
  ),
});
const jpegPart = z.object({
  type: z.literal("image_url"),
  image_url: z.object({ url: z.string().startsWith("data:image/jpeg;base64,/9j/") }),
});

/** @param {import("node:http").IncomingMessage} request @param {import("node:http").ServerResponse} response */
async function serveLabelFixture(request, response) {
  if (request.method !== "POST") {
    response.writeHead(405).end();
    return;
  }
  const { messages } = gatewayPrompt.parse(await json(request));
  const imageReceived = messages.some(
    ({ role, content }) =>
      role === "user" &&
      Array.isArray(content) &&
      content.some((part) => jpegPart.safeParse(part).success),
  );
  if (!imageReceived) {
    response.writeHead(422).end("Expected a JPEG from the local Images binding");
    return;
  }
  response.setHeader("content-type", "application/json");
  response.end(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify(labelExtractionFixture()) } }],
    }),
  );
}

try {
  const migration = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url)),
      "d1",
      "migrations",
      "apply",
      "booze",
      "--local",
      "--persist-to",
      path.join(directory, "state"),
      "--config",
      "wrangler.jsonc",
    ],
    { env: process.env, stdio: "inherit", timeout: 60_000 },
  );
  if (migration.status !== 0) throw new Error("Local browser-test migrations failed");
  const { createServer } = await import("vite");
  server = await createServer({
    plugins: [
      {
        name: "browser-test-label-gateway",
        configureServer(vite) {
          vite.middlewares.use("/__test__/label-gateway", (request, response) => {
            void serveLabelFixture(request, response).catch(() => {
              response.writeHead(400).end("Malformed local label request");
            });
          });
        },
      },
    ],
    server: { host: "127.0.0.1", port: 4174, strictPort: true },
  });
  await server.listen();
  server.printUrls();
} catch (error) {
  await close();
  throw error;
}
