// oxlint-disable import/no-default-export -- Vite discovers configuration through the default export.

import { astryxStylex } from "@astryxdesign/build/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { env } from "node:process";

const browserTestState = env["BOOZE_BROWSER_TEST_STATE"];

export default defineConfig({
  ...(browserTestState === undefined ? {} : { envDir: false }),
  envPrefix: ["VITE_", "CLERK_PUBLISHABLE_KEY"],
  // The source-built theme imports the Lucide barrel. Prebundle it for the dev server.
  optimizeDeps: { include: ["@astryxdesign/theme-neutral > lucide-react"] },
  server: {
    warmup: { clientFiles: ["./src/main.tsx", "./src/App.tsx", "./src/InventoryView.tsx"] },
  },
  plugins: [
    ...astryxStylex({ rootDir: import.meta.dirname }),
    react(),
    cloudflare(
      browserTestState === undefined
        ? {}
        : {
            configPath: "wrangler.jsonc",
            config(config) {
              // Mutate these complete maps: returning partial maps would merge file vars back in.
              config.vars = {
                AI_GATEWAY_URL: "http://127.0.0.1:4174/__test__/label-gateway",
                CF_AIG_TOKEN: "local-browser-test",
              };
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
