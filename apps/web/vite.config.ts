// oxlint-disable import/no-default-export -- Vite discovers configuration through the default export.

import { astryxStylex } from "@astryxdesign/build/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  envPrefix: ["VITE_", "CLERK_PUBLISHABLE_KEY"],
  // The source-built theme imports the Lucide barrel. Prebundle it for the dev server.
  optimizeDeps: { include: ["@astryxdesign/theme-neutral > lucide-react"] },
  server: {
    warmup: { clientFiles: ["./src/main.tsx", "./src/App.tsx", "./src/InventoryView.tsx"] },
  },
  plugins: [...astryxStylex({ rootDir: import.meta.dirname }), react(), cloudflare()],
});
