// oxlint-disable import/max-dependencies -- Exercises Workflow orchestration, artifact provenance, and confirmed atomic inventory together.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { describe, it } from "node:test";

import type { WorkflowStep } from "cloudflare:workers";
import { z } from "zod";
import { catalogueCandidateSchema } from "../shared/catalogue-inputs.ts";

import type { Bindings } from "./api/types.ts";
import { defaultBottleExtractorConfig, type BottleExtractorResult } from "./bottle-ocr.ts";
import { importReviewedCapture } from "./bottle-importer.ts";
import { createD1Client } from "@chikachow/booze-db";
import { asD1, migratedDatabase } from "./d1-support.ts";

// The base class only supplies env. Step persistence and model responses are
// explicit fixtures; all capture state transitions and D1 batches run for real.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") {
      return {
        shortCircuit: true,
        url: `data:text/javascript,${encodeURIComponent(
          "export class WorkflowEntrypoint { constructor(ctx, env) { this.env = env; } }",
        )}`,
      };
    }
    return nextResolve(specifier, context);
  },
});
const { BottleCaptureWorkflow } = await import("./bottle-capture-workflow.ts");
hooks.deregister();

await describe("capture Workflow draft creation", async () => {
  await it("keeps a high-confidence extraction as a reviewable draft without adding stock", async () => {
    const { sqlite, workflow } = setup("extracting");
    const output = await workflow.run(event("workflow"), fixtureSteps());
    assert.deepEqual(output, { captureId: "capture", status: "needs_review" });
    assert.equal(sqlite.prepare("SELECT count(*) AS count FROM bottles").get()?.["count"], 0);
    assert.equal(
      sqlite.prepare("SELECT status FROM bottle_captures").get()?.["status"],
      "needs_review",
    );
  });

  await it("makes one model request, retains photos and provenance, and never creates stock", async (t) => {
    const { sqlite, workflow, artifacts } = setup("queued");
    sqlite.exec(`INSERT INTO image_assets (id,site_id,uploaded_by_user_id,sha256,r2_key,content_type,size_bytes) VALUES ('image','site','user','hash','original','image/jpeg',3);
      INSERT INTO bottle_capture_images (capture_id,image_asset_id,sort_order) VALUES ('capture','image',0);`);
    let requests = 0;
    t.mock.method(globalThis, "fetch", async () => {
      requests += 1;
      return Response.json({
        provider: "fixture",
        choices: [{ message: { content: JSON.stringify(extraction()) } }],
      });
    });
    const output = await workflow.run(event("workflow"), fixtureSteps(new Map(), false));
    assert.deepEqual(output, { captureId: "capture", status: "needs_review" });
    assert.equal(requests, 1);
    assert.equal(sqlite.prepare("SELECT count(*) AS count FROM bottles").get()?.["count"], 0);
    assert.equal(sqlite.prepare("SELECT r2_key FROM image_assets").get()?.["r2_key"], "original");
    const artifact = z
      .object({
        workflowInstanceId: z.string(),
        images: z.array(z.object({ r2Key: z.string() })),
        extractor: z.object({
          provenance: z.string(),
          configuration: z.object({ model: z.string(), promptVersion: z.string() }),
          rawResponse: z.string(),
        }),
      })
      .parse(JSON.parse(String(artifacts.values().next().value)));
    assert.equal(artifact.workflowInstanceId, "workflow");
    assert.equal(artifact.images[0]?.r2Key, "original");
    assert.equal(artifact.extractor.provenance, "capture-extraction-v2");
    assert.equal(artifact.extractor.configuration.model, "google/gemini-3-flash-preview");
    assert.equal(artifact.extractor.configuration.promptVersion, "capture-review-v2");
    assert.ok(artifact.extractor.rawResponse.includes('"provider":"fixture"'));
  });

  await it("does not restart failed, review, or historical importing states without deliberate retry", async () => {
    for (const status of ["importing", "failed", "needs_review"]) {
      const { sqlite, workflow } = setup(status);
      const output = await workflow.run(event("workflow"), fixtureSteps());
      assert.deepEqual(output, { captureId: "capture", status: "skipped" });
      assert.equal(sqlite.prepare("SELECT status FROM bottle_captures").get()?.["status"], status);
      assert.equal(sqlite.prepare("SELECT count(*) AS count FROM bottles").get()?.["count"], 0);
      assert.equal(
        sqlite.prepare("SELECT count(*) AS count FROM bottle_capture_runs").get()?.["count"],
        1,
      );
    }
  });

  await it("adds the exact capture quantity only after confirmation and replays one receipt", async () => {
    const { sqlite, workflow, artifacts } = setup("queued");
    sqlite.exec("UPDATE bottle_captures SET quantity = 3");
    const output = await workflow.run(event("workflow"), fixtureSteps());
    assert.deepEqual(output, { captureId: "capture", status: "needs_review" });
    assert.equal(sqlite.prepare("SELECT count(*) AS count FROM bottles").get()?.["count"], 0);
    const artifact = z
      .object({
        schemaVersion: z.string(),
        extractor: z.object({
          result: z.object({ canonical_label_text_lines: z.array(z.string()) }),
          rawResponse: z.string(),
        }),
        importCandidate: catalogueCandidateSchema.extend({ rawSuggestion: z.unknown() }),
      })
      .parse(JSON.parse(String(artifacts.values().next().value)));
    assert.equal(artifact.schemaVersion, "capture-extraction-v2");
    assert.deepEqual(artifact.extractor.result.canonical_label_text_lines, [
      "Producer",
      "Reserve",
      "2020",
    ]);
    assert.equal(
      z.object({ provider: z.string() }).parse(JSON.parse(artifact.extractor.rawResponse)).provider,
      "fixture-provider",
    );
    const input = {
      candidate: artifact.importCandidate,
      captureId: "capture",
      database: createD1Client(asD1(sqlite)),
      runId: "run_workflow",
      workflowInstanceId: "workflow",
      quantity: 3,
      siteId: "site",
      userId: "user",
      expectedReviewRevision: 0,
    };
    const imported = await importReviewedCapture(input);
    assert.deepEqual(
      await importReviewedCapture({
        ...input,
        candidate: { wine: { wineryName: "" }, bottle: { volumeMl: -1 }, rawSuggestion: {} },
      }),
      imported,
    );
    assert.equal(sqlite.prepare("SELECT count(*) AS count FROM bottles").get()?.["count"], 3);
    assert.equal(
      sqlite
        .prepare("SELECT count(*) AS count FROM bottle_capture_runs WHERE status='imported'")
        .get()?.["count"],
      1,
    );
  });

  await it("uses event ownership with an old persisted run context that has no Workflow ID", async () => {
    const { sqlite, workflow } = setup("extracting");
    const output = await workflow.run(event("workflow"), fixtureSteps(legacySteps()));
    assert.deepEqual(output, { captureId: "capture", status: "needs_review" });
    assert.equal(sqlite.prepare("SELECT count(*) AS count FROM bottles").get()?.["count"], 0);
    assert.equal(
      sqlite.prepare("SELECT status FROM bottle_capture_runs WHERE id = 'legacy-run'").get()?.[
        "status"
      ],
      "needs_review",
    );
  });

  await it("retains legacy checkpoint evidence without inventing raw response or configuration", async () => {
    const { workflow, artifacts } = setup("extracting");
    const cache = legacySteps();
    cache.set("extract label evidence with google-gemini-3-flash-preview", {
      extractorId: "legacy",
      model: "old-model",
      diagnostics: [],
      result: extraction(),
    });
    const output = await workflow.run(event("workflow"), fixtureSteps(cache));
    assert.deepEqual(output, { captureId: "capture", status: "needs_review" });
    const artifact = z
      .object({
        extractor: z.object({
          provenance: z.string(),
          configuration: z.null(),
          rawResponse: z.null(),
          model: z.string(),
        }),
      })
      .parse(JSON.parse(String(artifacts.values().next().value)));
    assert.equal(artifact.extractor.provenance, "legacy_workflow_checkpoint");
    assert.equal(artifact.extractor.model, "old-model");
  });

  await it("does not let an old cached start and run context bypass a newer Workflow owner", async () => {
    const { sqlite, workflow } = setup("extracting");
    sqlite.exec("UPDATE bottle_captures SET workflow_instance_id = 'new'");
    const output = await workflow.run(event("workflow"), fixtureSteps(legacySteps()));
    assert.deepEqual(output, { captureId: "capture", status: "skipped" });
    assert.equal(
      sqlite.prepare("SELECT status FROM bottle_captures").get()?.["status"],
      "extracting",
    );
    assert.equal(sqlite.prepare("SELECT count(*) AS count FROM bottles").get()?.["count"], 0);
  });

  await it("does not restart an imported capture or another owner's capture", async () => {
    for (const [status, owner] of [
      ["imported", "workflow"],
      ["failed", "new"],
    ] as const) {
      const { sqlite, workflow } = setup(status);
      sqlite.prepare("UPDATE bottle_captures SET workflow_instance_id = ?").run(owner);
      const output = await workflow.run(event("workflow"), fixtureSteps());
      assert.deepEqual(output, { captureId: "capture", status: "skipped" });
      assert.equal(sqlite.prepare("SELECT status FROM bottle_captures").get()?.["status"], status);
      assert.equal(
        sqlite.prepare("SELECT count(*) AS count FROM bottle_capture_runs").get()?.["count"],
        1,
      );
      assert.equal(sqlite.prepare("SELECT count(*) AS count FROM bottles").get()?.["count"], 0);
    }
  });
});

function setup(status: string) {
  const sqlite = migratedDatabase();
  sqlite.exec(`INSERT INTO users (id, clerk_user_id) VALUES ('user', 'user');
    INSERT INTO sites (id, name) VALUES ('site', 'Cellar');
    INSERT INTO site_memberships (site_id,user_id,role) VALUES ('site','user','owner');`);
  sqlite
    .prepare(`INSERT INTO bottle_captures (id, site_id, user_id, status, workflow_instance_id)
    VALUES ('capture', 'site', 'user', ?, 'workflow')`)
    .run(status);
  sqlite
    .prepare(`INSERT INTO bottle_capture_runs (id, capture_id, status, extractor_version, prompt_version, schema_version)
    VALUES ('legacy-run', 'capture', ?, 'old-extractor', 'old-prompt', 'old-schema')`)
    .run(status);
  const artifacts = new Map<string, unknown>();
  // oxlint-disable typescript/no-unsafe-type-assertion -- Persisted model-step fixtures leave only D1 and artifact writes live.
  const bindings = {
    DB: asD1(sqlite),
    CF_AIG_TOKEN: "fixture",
    AI_GATEWAY_URL: "https://ocr.invalid/chat/completions",
    IMAGE_BUCKET: {
      async get() {
        return { body: new Response(new Uint8Array([1, 2, 3])).body };
      },
      async put(key: string, value: unknown) {
        artifacts.set(key, value);
      },
    },
  } as unknown as Bindings;
  // oxlint-enable typescript/no-unsafe-type-assertion
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The test Workflow base class only uses its environment argument.
  const workflow = new BottleCaptureWorkflow({} as ExecutionContext, bindings);
  return { sqlite, workflow, artifacts };
}

function event(instanceId: string) {
  return {
    instanceId,
    workflowName: "booze-bottle-captures",
    payload: { captureId: "capture" },
    timestamp: new Date(),
  };
}

function legacySteps(): Map<string, unknown> {
  return new Map<string, unknown>([
    ["mark capture extracting", { captureId: "capture" }],
    [
      "create capture run",
      {
        capture: {
          id: "capture",
          siteId: "site",
          userId: "user",
          quantity: 1,
          storageLocationId: null,
          positionHint: null,
          images: [],
        },
        runId: "legacy-run",
      },
    ],
  ]);
}

function fixtureSteps(cache = new Map<string, unknown>(), modelFixture = true): WorkflowStep {
  const step = {
    // oxlint-disable-next-line promise/prefer-await-to-callbacks -- WorkflowStep.do requires a callback; this test invokes the supplied step body.
    async do(name: string, optionsOrCallback: unknown, callback?: () => Promise<unknown>) {
      if (cache.has(name)) return cache.get(name);
      if (modelFixture && name.startsWith("extract label evidence with ")) {
        return {
          extractorId: name,
          model: "fixture",
          diagnostics: [],
          result: extraction(),
          configuration: defaultBottleExtractorConfig,
          rawResponse: JSON.stringify({
            provider: "fixture-provider",
            choices: [{ message: { content: JSON.stringify(extraction()) } }],
          }),
        };
      }
      const execute = callback ?? optionsOrCallback;
      assert.ok(typeof execute === "function");
      // oxlint-disable-next-line typescript/no-unsafe-call -- The callback guard verifies the Workflow step supplies a callable function.
      const result: unknown = await execute();
      cache.set(name, result);
      return result;
    },
  };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The orchestration uses only the modeled do method.
  return step as unknown as WorkflowStep;
}

function extraction(): BottleExtractorResult {
  return {
    model_role: "extractor",
    bottle_same_across_images: true,
    raw_text_by_image: [],
    fields: {
      wineryName: textField("Producer"),
      brandName: textField(null),
      displayName: textField("Reserve"),
      vintage: textField("2020"),
      wineType: textField(null),
      wineColor: textField(null),
      grapeVarieties: { ...textField(null), value: [] },
      country: textField(null),
      region: textField(null),
      appellation: textField(null),
      classification: textField(null),
      alcoholPercent: textField(null),
      bottleVolumeMl: textField(null),
      addressQualification: textField(null),
      barcode: textField(null),
      lotCode: textField(null),
      description: textField(null),
      drinkingAdvice: textField(null),
    },
    canonical_label_text_lines: ["Producer", "Reserve", "2020"],
    warnings: [],
    overall_confidence: 0.9,
  };
}

function textField(value: string | null) {
  return { value, confidence: 0.9, evidence: [], notes: [] };
}
