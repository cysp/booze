import { expect, test as base, type APIRequestContext } from "@playwright/test";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { env } from "node:process";
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import { z } from "zod";

const headers = { "x-dev-user": "local-browser" };
const createdResourceSchema = z.object({ data: z.object({ id: z.string() }) });

type LocalCatalogue = {
  readonly siteId: string;
  readonly siteName: string;
  readonly firstLocationId: string;
  readonly secondLocationId: string;
};

async function createResource(
  request: APIRequestContext,
  url: string,
  data: Readonly<Record<string, string>>,
): Promise<string> {
  const response = await request.post(url, { data, headers });
  expect(response.status(), await response.text()).toBe(201);
  return createdResourceSchema.parse(await response.json()).data.id;
}

export const test = base.extend<{ localCatalogue: LocalCatalogue }>({
  localCatalogue: async ({ request }, use) => {
    const siteName = "Browser test cellar";
    const siteId = await createResource(request, "/api/sites", { name: siteName });
    try {
      const firstLocationId = await createResource(request, "/api/storage-locations", {
        locationType: "rack",
        name: "First rack",
        siteId,
      });
      const secondLocationId = await createResource(request, "/api/storage-locations", {
        locationType: "shelf",
        name: "Second shelf",
        siteId,
      });
      await use({ firstLocationId, secondLocationId, siteId, siteName });
    } finally {
      const response = await request.delete(`/api/sites/${encodeURIComponent(siteId)}`, {
        headers,
      });
      expect(response.status(), await response.text()).toBe(204);
    }
  },
});

export function nativeRows(
  sql: string,
  ...parameters: readonly SQLInputValue[]
): readonly Record<string, SQLOutputValue>[] {
  const directory = env["BOOZE_BROWSER_TEST_STATE"];
  if (
    directory === undefined ||
    path.dirname(directory) !== tmpdir() ||
    !/^booze-playwright-[\da-f-]+$/u.test(path.basename(directory))
  ) {
    throw new Error("Native assertions require Playwright's temporary database");
  }
  const d1Directory = path.join(directory, "state", "v3", "d1");
  const files = readdirSync(d1Directory, { encoding: "utf8", recursive: true }).filter(
    (name) => name.endsWith(".sqlite") && path.basename(name) !== "metadata.sqlite",
  );
  expect(files).toHaveLength(1);
  const database = new DatabaseSync(path.join(d1Directory, files[0] ?? ""), { readOnly: true });
  try {
    return database.prepare(sql).all(...parameters);
  } finally {
    database.close();
  }
}

export { expect };
