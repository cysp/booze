// oxlint-disable import/no-default-export -- Vite discovers configuration through the default export.

import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { env } from "node:process";

const browserTestState = env["BOOZE_BROWSER_TEST_STATE"];

export default defineConfig({
  ...(browserTestState === undefined ? {} : { envDir: false }),
  envPrefix: ["VITE_", "CLERK_PUBLISHABLE_KEY"],
  plugins: [
    react(),
    cloudflare(
      browserTestState === undefined
        ? {}
        : {
            configPath: "wrangler.jsonc",
            config(config) {
              // Mutate these complete maps: returning partial maps would merge file vars back in.
              config.vars = {};
              config.secrets = { required: [] };
              config.triggers = { crons: [] };
            },
            inspectorPort: false,
            persistState: { path: `${browserTestState}/state` },
            remoteBindings: false,
          },
    ),
  ],
});
