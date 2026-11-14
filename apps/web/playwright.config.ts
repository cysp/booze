// oxlint-disable import/no-default-export -- Playwright discovers configuration through the default export.
import { defineConfig } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { env } from "node:process";

// Discovery creates no state. The server exclusively creates and removes this directory.
env["BOOZE_BROWSER_TEST_STATE"] ??= path.join(tmpdir(), `booze-playwright-${randomUUID()}`);

export default defineConfig({
  expect: { timeout: 5_000 },
  fullyParallel: false,
  outputDir: "/tmp/booze-playwright-results",
  projects: [
    { name: "chrome-light", use: { colorScheme: "light" } },
    { name: "chrome-dark", use: { colorScheme: "dark" } },
  ],
  reporter: "line",
  testDir: "./e2e",
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:4174",
    channel: "chrome",
    reducedMotion: "reduce",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "exec node scripts/browser-test-server.mjs",
    gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
    reuseExistingServer: false,
    timeout: 120_000,
    url: "http://127.0.0.1:4174/healthz",
  },
  workers: 1,
});
