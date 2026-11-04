import { Theme } from "@astryxdesign/core/theme";
import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
// oxlint-disable-next-line import/no-unassigned-import -- Loads the self-hosted Figtree variable font.
import "@fontsource-variable/figtree";

import { App } from "./App.tsx";
import { LazyLoadErrorBoundary } from "./LazyLoadErrorBoundary.tsx";
// oxlint-disable-next-line import/no-unassigned-import -- The compiled theme CSS must load once.
import "./generated/booze.css";
import { boozeTheme } from "./generated/booze.js";

const rootElement = document.querySelector("#root");

if (rootElement === null) {
  throw new Error("Root element not found");
}

function envString(name: string): string | undefined {
  const value: unknown = import.meta.env[name];
  return typeof value === "string" && value !== "" ? value : undefined;
}

const publishableKey =
  envString("VITE_CLERK_PUBLISHABLE_KEY") ?? envString("CLERK_PUBLISHABLE_KEY");
const isLocalDevHost =
  window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
const forceDevelopmentAuth = isLocalDevHost && envString("VITE_AUTH_MODE") === "development";

const ClerkApp = lazy(async () => {
  const module = await import("./ClerkApp.tsx");
  return { default: module.ClerkApp };
});

createRoot(rootElement).render(
  <StrictMode>
    <Theme mode="system" theme={boozeTheme}>
      {(publishableKey === undefined && isLocalDevHost) || forceDevelopmentAuth ? (
        <App authMode="development" />
      ) : publishableKey === undefined ? (
        <main className="auth-shell">
          <section className="auth-panel" aria-labelledby="auth-config-title">
            <p>Authentication unavailable</p>
            <h1 id="auth-config-title">This deployment is missing Clerk configuration.</h1>
          </section>
        </main>
      ) : (
        <LazyLoadErrorBoundary
          description="Reload the latest application files and try signing in again."
          title="Authentication could not be loaded"
        >
          <Suspense fallback={<p role="status">Loading authentication…</p>}>
            <ClerkApp publishableKey={publishableKey} />
          </Suspense>
        </LazyLoadErrorBoundary>
      )}
    </Theme>
  </StrictMode>,
);
