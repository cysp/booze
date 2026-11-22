import { render, screen } from "@testing-library/react";
import { Suspense, type ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { ClerkApp } from "./ClerkApp.tsx";

const chunk = vi.hoisted(() => Promise.withResolvers<never>());
vi.mock("./App.tsx", async () => chunk.promise);
vi.mock("@clerk/react", () => ({
  ClerkProvider: ({ children }: { children: ReactNode }): ReactNode => children,
  Show: ({ children, when }: { children: ReactNode; when: string }): ReactNode =>
    when === "signed-in" ? children : null,
  RedirectToSignIn: () => null,
  UserButton: () => null,
  useAuth: () => ({ getToken: vi.fn(), userId: "signed-in-user" }),
}));

it("keeps a signed-in catalogue load and its recovery inside the catalogue", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {
    // React reports the rejected chunk to the error boundary.
  });
  render(
    <Suspense fallback={<p role="status">Loading authentication…</p>}>
      <ClerkApp publishableKey="fixture" />
    </Suspense>,
  );
  expect(screen.getByRole("status")).toHaveTextContent("Loading catalogue…");
  chunk.reject(new Error("Catalogue chunk unavailable"));
  expect(await screen.findByRole("alert", { name: "Catalogue could not be loaded" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
});
