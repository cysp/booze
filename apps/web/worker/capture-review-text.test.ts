// oxlint-disable import/max-dependencies -- Verify OCR text through review, import, and subsequent browser-driven wine edits.
import assert from "node:assert/strict";
import { it } from "node:test";
import { Hono } from "hono";
import { bottleEditPayload } from "../src/bottle-payload.ts";
import { formStateForItem } from "../src/inventory-model.ts";
import { inventoryItemFixture } from "../src/test/catalogue-fixtures.ts";
import { problemResponseForError } from "./api/http.ts";
import { userIdForClerkUser } from "./api/ids.ts";
import type { Bindings } from "./api/types.ts";
import { buildCaptureImportCandidate } from "./bottle-extractor.ts";
import { asD1, migratedDatabase } from "./d1-support.ts";
import { bottleCaptureRoutes } from "./routes/bottle-captures.ts";
import { bottleRoutes } from "./routes/bottles.ts";

const addressQualification = "Producer and importer address evidence ".repeat(20).slice(0, 500);
const wineType = `${"Traditional method sparkling white wine ".repeat(4).slice(0, 119)}.`;

function textField(value: string | null = null) {
  return { value, confidence: 0.9, evidence: [], notes: [] };
}

function extractedCandidate() {
  return buildCaptureImportCandidate({
    extraction: {
      extractorId: "fixture",
      model: "fixture",
      result: {
        model_role: "extractor",
        bottle_same_across_images: true,
        raw_text_by_image: [],
        fields: {
          wineryName: textField("Producer"),
          brandName: textField(),
          displayName: textField(),
          vintage: textField("2024"),
          wineType: textField(wineType),
          wineColor: textField("white"),
          grapeVarieties: { ...textField(), value: ["Chardonnay"] },
          country: textField(),
          region: textField(),
          appellation: textField(),
          classification: textField(),
          alcoholPercent: textField(),
          bottleVolumeMl: textField("750 ml"),
          addressQualification: textField(addressQualification),
          barcode: textField(),
          lotCode: textField(),
          description: textField(),
          drinkingAdvice: textField(),
        },
        canonical_label_text_lines: [],
        warnings: ["Check label"],
        overall_confidence: 0.9,
      },
    },
  }).candidate;
}

function setup() {
  const sqlite = migratedDatabase();
  const user = userIdForClerkUser("dev:tester");
  sqlite.prepare("INSERT INTO users (id, clerk_user_id) VALUES (?, 'dev:tester')").run(user);
  sqlite.exec("INSERT INTO sites (id, name) VALUES ('site', 'Home')");
  sqlite
    .prepare("INSERT INTO site_memberships (site_id, user_id, role) VALUES ('site', ?, 'owner')")
    .run(user);
  sqlite
    .prepare(
      "INSERT INTO bottle_captures (id, site_id, user_id, status, quantity) VALUES ('capture', 'site', ?, 'needs_review', 2)",
    )
    .run(user);
  const candidate = extractedCandidate();
  sqlite
    .prepare(
      "INSERT INTO bottle_capture_runs (id, capture_id, status, import_candidate_json, extractor_version, prompt_version, schema_version) VALUES ('run', 'capture', 'needs_review', ?, 'v1', 'v1', 'v1')",
    )
    .run(JSON.stringify(candidate));
  const app = new Hono<{ Bindings: Bindings }>()
    .route("/", bottleCaptureRoutes)
    .route("/", bottleRoutes)
    .onError(problemResponseForError);
  return {
    sqlite,
    candidate,
    request: async (method: string, path: string, payload: Record<string, unknown>) =>
      app.request(
        `http://localhost${path}`,
        {
          method,
          headers: { "content-type": "application/json", "x-dev-user": "tester" },
          body: JSON.stringify({
            ...(method === "POST" && path === "/bottles"
              ? { operationId: crypto.randomUUID() }
              : {}),
            ...payload,
          }),
        },
        { DB: asD1(sqlite) },
      ),
  };
}

for (const saveFirst of [false, true]) {
  await it(`preserves accepted OCR text through ${saveFirst ? "saved correction and" : "direct"} capture import`, async () => {
    const { sqlite, candidate, request } = setup();
    try {
      if (saveFirst) {
        const saved = await request("PATCH", "/bottle-captures/capture/review", {
          expectedRevision: 0,
          candidate: { ...candidate, wine: { ...candidate.wine, designation: "Reviewed cuvee" } },
        });
        assert.equal(saved.status, 200, await saved.text());
        assert.equal(sqlite.prepare("SELECT count(*) AS count FROM bottles").get()?.["count"], 0);
      }
      const imported = await request("POST", "/bottle-captures/capture/import", {
        expectedReviewRevision: saveFirst ? 1 : 0,
      });
      assert.equal(imported.status, 200, await imported.text());
      assert.deepEqual(
        { ...sqlite.prepare("SELECT address_qualification, wine_type FROM wine_vintages").get() },
        { address_qualification: addressQualification, wine_type: wineType },
      );
      assert.equal(sqlite.prepare("SELECT count(*) AS count FROM bottles").get()?.["count"], 2);
      const original = sqlite
        .prepare("SELECT import_candidate_json FROM bottle_capture_runs")
        .get();
      assert.equal(original?.["import_candidate_json"], JSON.stringify(candidate));
    } finally {
      sqlite.close();
    }
  });
}

await it("preserves accepted OCR text through later separate-wine and shared correction payloads", async () => {
  const { sqlite, request } = setup();
  try {
    sqlite.exec("INSERT INTO wineries (id,site_id,name) VALUES ('winery','site','Producer')");
    sqlite
      .prepare(
        "INSERT INTO wine_vintages (id,site_id,winery_id,base_name,display_name,vintage_label,address_qualification,wine_type) VALUES ('wine','site','winery','','Producer Chardonnay','Unknown',?,?)",
      )
      .run(addressQualification, wineType);
    sqlite.exec(
      "INSERT INTO bottles (id,site_id,wine_vintage_id) VALUES ('one','site','wine'),('two','site','wine')",
    );
    const item = inventoryItemFixture({
      id: "one",
      siteId: "site",
      wineVintageId: "wine",
      wineryId: "winery",
      wineryName: "Producer",
      addressQualification,
      wineType,
      wineBottleCount: 2,
      storageLocationId: null,
      vintageYear: null,
      vintageStatus: "unknown",
    });
    const form = formStateForItem(item);
    form.vintageStatus = "year";
    form.vintageYear = "2024";
    const clone = await request(
      "PATCH",
      "/bottles/one",
      bottleEditPayload(
        {
          form,
          wineEditScope: "bottle",
          awards: [],
          criticReviews: [],
        },
        item,
      ),
    );
    assert.equal(clone.status, 200, await clone.text());
    assert.deepEqual(
      {
        ...sqlite
          .prepare(
            "SELECT w.address_qualification, w.wine_type FROM bottles b JOIN wine_vintages w ON w.id=b.wine_vintage_id WHERE b.id='one'",
          )
          .get(),
      },
      { address_qualification: addressQualification, wine_type: wineType },
    );
    const correction = await request("PATCH", "/bottles/two", {
      wineEditScope: "shared",
      expectedWineVintageId: "wine",
      expectedAffectedBottleCount: 1,
      wine: {
        addressQualification: addressQualification.replace("Producer", "Importer"),
        wineType,
      },
    });
    assert.equal(correction.status, 200, await correction.text());
    assert.equal(
      sqlite.prepare("SELECT address_qualification FROM wine_vintages WHERE id='wine'").get()?.[
        "address_qualification"
      ],
      addressQualification.replace("Producer", "Importer"),
    );
  } finally {
    sqlite.close();
  }
});

await it("rejects text beyond the OCR contract without saving corrections or creating bottles", async () => {
  const { sqlite, candidate, request } = setup();
  try {
    for (const wine of [
      { ...candidate.wine, addressQualification: `${addressQualification}x` },
      { ...candidate.wine, wineType: `${wineType}x` },
    ]) {
      const review = await request("PATCH", "/bottle-captures/capture/review", {
        expectedRevision: 0,
        candidate: { ...candidate, wine },
      });
      assert.equal(review.status, 400);
      const create = await request("POST", "/bottles", { siteId: "site", wine });
      assert.equal(create.status, 400);
    }
    assert.equal(
      sqlite.prepare("SELECT review_revision FROM bottle_captures").get()?.["review_revision"],
      0,
    );
    assert.equal(sqlite.prepare("SELECT count(*) AS count FROM bottles").get()?.["count"], 0);
  } finally {
    sqlite.close();
  }
});
