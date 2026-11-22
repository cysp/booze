// oxlint-disable import/max-dependencies -- Exercises durable launch across intake, HTTP, D1, and Workflow handoff.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createD1Client } from "@chikachow/booze-db";
import { Hono } from "hono";
import { problemResponseForError } from "./api/http.ts";
import { userIdForClerkUser } from "./api/ids.ts";
import type { Bindings } from "./api/types.ts";
import { createBottleCapture } from "./capture-intake.ts";
import { ensureCaptureWorkflowStarted, startQueuedCaptureWorkflows } from "./capture-start.ts";
import { asD1, migratedDatabase } from "./d1-support.ts";
import { multipartBucket } from "./multipart-support.ts";
import { bottleCaptureRoutes } from "./routes/bottle-captures.ts";

const app = new Hono<{ Bindings: Bindings }>()
  .route("/", bottleCaptureRoutes)
  .onError(problemResponseForError);

function setup(
  start: (id: string) => Promise<void> = async () => {
    /* Successful launch fixture. */
  },
) {
  const sqlite = migratedDatabase();
  const userId = userIdForClerkUser("dev:tester");
  sqlite.prepare("INSERT INTO users(id,clerk_user_id) VALUES(?,'dev:tester')").run(userId);
  sqlite.exec("INSERT INTO sites(id,name) VALUES('site','Cellar')");
  sqlite
    .prepare("INSERT INTO site_memberships(site_id,user_id,role) VALUES('site',?,'owner')")
    .run(userId);
  const storage = multipartBucket();
  const d1 = asD1(sqlite);
  const input = {
    bucket: storage.bucket,
    database: createD1Client(d1),
    operationId: crypto.randomUUID(),
    files: [new File(["photo"], "label.jpg", { type: "image/jpeg" })],
    siteId: "site",
    userId,
    quantity: 1,
    storageLocationId: null,
    positionHint: null,
  };
  const launches: string[] = [];
  async function launch(id: string) {
    launches.push(id);
    await start(id);
    return { id };
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The route fixture implements the Workflow creation operations under test.
  const bindings = {
    DB: d1,
    IMAGE_BUCKET: storage.bucket,
    BOTTLE_CAPTURE_WORKFLOW: {
      async create({ id }: { readonly id: string }) {
        return launch(id);
      },
      async createBatch({ instances }: { readonly instances: readonly { readonly id: string }[] }) {
        return {
          created: await Promise.all(instances.map(async ({ id }) => launch(id))),
          errors: [],
        };
      },
    },
  } as unknown as Bindings;
  async function submit() {
    const body = new FormData();
    body.set("operationId", input.operationId);
    body.set("siteId", "site");
    body.set("quantity", "1");
    for (const file of input.files) body.append("images", file);
    return app.request(
      "http://localhost/bottle-captures",
      { method: "POST", headers: { "x-dev-user": "tester" }, body },
      bindings,
    );
  }
  return { sqlite, d1, input, bindings, launches, submit, ...storage };
}

await describe("durable capture launch intent", async () => {
  await it("launches a queued receipt replay after the intake request died before handoff", async () => {
    const fixture = setup();
    const saved = await createBottleCapture(fixture.input);
    assert.equal(saved.status, "queued");
    assert.deepEqual(fixture.launches, []);
    const replay = await fixture.submit();
    assert.equal(replay.status, 201, await replay.clone().text());
    assert.deepEqual(fixture.launches, [saved.captureId]);
    assert.equal(fixture.objects.size, 1);
    assert.equal(fixture.counts.completed, 1);
  });

  await it("retains the queued owner when the Workflow create acknowledgement is unknown", async () => {
    const fixture = setup(async () => {
      throw new Error("Create acknowledgement lost");
    });
    const response = await fixture.submit();
    assert.equal(response.status, 201, await response.clone().text());
    const capture = fixture.sqlite
      .prepare("SELECT id,status,workflow_instance_id,error_message FROM bottle_captures")
      .get();
    assert.equal(capture?.["status"], "queued");
    assert.equal(capture["workflow_instance_id"], capture["id"]);
    assert.match(String(capture["error_message"]), /automatically/iu);
  });

  await it("ensures an already queued retry without allocating another owner", async () => {
    const fixture = setup();
    const saved = await createBottleCapture(fixture.input);
    const response = await app.request(
      `http://localhost/bottle-captures/${saved.captureId}/retry`,
      { method: "POST", headers: { "x-dev-user": "tester" } },
      fixture.bindings,
    );
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(fixture.launches, [saved.captureId]);
    assert.equal(
      fixture.sqlite.prepare("SELECT workflow_instance_id FROM bottle_captures").get()?.[
        "workflow_instance_id"
      ],
      saved.captureId,
    );
  });

  await it("recognizes only the documented existing-instance code after an unknown acknowledgement", async (context) => {
    context.mock.method(console, "error", () => {
      /* Expected injected platform failures. */
    });
    for (const code of [10405, 10415, 99999]) {
      const fixture = setup();
      const saved = await createBottleCapture(fixture.input);
      const result = await ensureCaptureWorkflowStarted({
        captureId: saved.captureId,
        database: fixture.input.database,
        workflow: batchBinding(async () => ({
          created: [],
          errors: [
            {
              index: 0,
              id: saved.captureId,
              code,
              message: "An instance with this ID already exists.",
            },
          ],
        })),
      });
      assert.equal(result.errorMessage === undefined, code === 10405);
      assert.equal(
        fixture.sqlite.prepare("SELECT status FROM bottle_captures").get()?.["status"],
        "queued",
      );
    }
  });

  await it("keeps one Workflow ID when replay and maintenance overlap", async () => {
    const fixture = setup();
    const saved = await createBottleCapture(fixture.input);
    const instances = new Set<string>();
    const workflow = batchBinding(async ({ instances: requested }) => {
      const id = requested[0]?.id;
      assert.ok(id !== undefined);
      if (instances.has(id))
        return { created: [], errors: [{ index: 0, id, code: 10405, message: "exists" }] };
      instances.add(id);
      return { created: [{ id }], errors: [] };
    });
    await Promise.all([
      ensureCaptureWorkflowStarted({
        captureId: saved.captureId,
        database: fixture.input.database,
        workflow,
      }),
      startQueuedCaptureWorkflows({ database: fixture.input.database, workflow }),
    ]);
    assert.deepEqual([...instances], [saved.captureId]);
  });

  await it("bounds maintenance and rotates unavailable intents so later captures get a turn", async (context) => {
    context.mock.method(console, "error", () => {
      /* Expected injected platform failures. */
    });
    const fixture = setup(async () => {
      throw new Error("Unavailable");
    });
    for (let index = 0; index < 70; index += 1) {
      fixture.sqlite
        .prepare(`INSERT INTO bottle_captures(id,site_id,user_id,status,workflow_instance_id,updated_at)
        VALUES (?,'site',?,'queued',?,'2000-01-01 00:00:00')`)
        .run(
          `capture_${index.toString().padStart(2, "0")}`,
          fixture.input.userId,
          `owner_${index}`,
        );
    }
    await startQueuedCaptureWorkflows({
      database: fixture.input.database,
      workflow: fixture.bindings.BOTTLE_CAPTURE_WORKFLOW,
    });
    assert.equal(fixture.launches.length, 50);
    await startQueuedCaptureWorkflows({
      database: fixture.input.database,
      workflow: fixture.bindings.BOTTLE_CAPTURE_WORKFLOW,
    });
    assert.equal(fixture.launches.length, 100);
    assert.equal(new Set(fixture.launches).size, 70);
    assert.equal(
      fixture.sqlite
        .prepare("SELECT count(*) AS n FROM bottle_captures WHERE status='queued'")
        .get()?.["n"],
      70,
    );
  });

  await it("does not relaunch completed or historical importing records during maintenance", async () => {
    const fixture = setup();
    for (const status of [
      "needs_review",
      "failed",
      "imported",
      "importing",
      "uploading",
      "upload_failed",
    ]) {
      fixture.sqlite
        .prepare(`INSERT INTO bottle_captures(id,site_id,user_id,status,workflow_instance_id)
        VALUES (?,'site',?,?,?)`)
        .run(status, fixture.input.userId, status, `${status}_owner`);
    }
    await startQueuedCaptureWorkflows({
      database: fixture.input.database,
      workflow: fixture.bindings.BOTTLE_CAPTURE_WORKFLOW,
    });
    assert.deepEqual(fixture.launches, []);
  });

  await it("uses a platform-safe new owner while preserving an opaque historical capture ID", async () => {
    const fixture = setup();
    const id = " legacy/capture 🍷 ";
    fixture.sqlite
      .prepare("INSERT INTO bottle_captures(id,site_id,user_id,status) VALUES(?,'site',?,'failed')")
      .run(id, fixture.input.userId);
    const response = await app.request(
      `http://localhost/bottle-captures/${encodeURIComponent(id)}/retry`,
      { method: "POST", headers: { "x-dev-user": "tester" } },
      fixture.bindings,
    );
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(fixture.sqlite.prepare("SELECT id FROM bottle_captures").get()?.["id"], id);
    assert.match(fixture.launches[0] ?? "", /^[0-9a-f-]{36}$/u);
  });

  await it("rejects a stale retry snapshot when saved corrections change before reservation", async () => {
    const fixture = setup();
    fixture.sqlite
      .prepare(
        "INSERT INTO bottle_captures(id,site_id,user_id,status,workflow_instance_id) VALUES('capture','site',?,'needs_review','old')",
      )
      .run(fixture.input.userId);
    const batch = fixture.d1.batch.bind(fixture.d1);
    fixture.d1.batch = async (statements) => {
      fixture.sqlite.exec(
        "UPDATE bottle_captures SET review_revision=1,review_candidate_json='{}'",
      );
      return batch(statements);
    };
    const response = await app.request(
      "http://localhost/bottle-captures/capture/retry",
      { method: "POST", headers: { "x-dev-user": "tester" } },
      fixture.bindings,
    );
    assert.equal(response.status, 409);
    assert.equal(
      fixture.sqlite.prepare("SELECT workflow_instance_id FROM bottle_captures").get()?.[
        "workflow_instance_id"
      ],
      "old",
    );
    assert.deepEqual(fixture.launches, []);
  });

  await it("finishes a retry whose owner reservation committed but lost its D1 acknowledgement", async () => {
    for (const continuation of ["retry", "maintenance"]) {
      const fixture = setup();
      fixture.sqlite
        .prepare(`INSERT INTO bottle_captures(id,site_id,user_id,status,workflow_instance_id)
        VALUES('capture','site',?,'failed','old')`)
        .run(fixture.input.userId);
      const batch = fixture.d1.batch.bind(fixture.d1);
      let first = true;
      fixture.d1.batch = async <T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
        const result = await batch<T>(statements);
        if (first) {
          first = false;
          throw new Error("Reservation committed; D1 acknowledgement lost");
        }
        return result;
      };
      const interrupted = await app.request(
        "http://localhost/bottle-captures/capture/retry",
        { method: "POST", headers: { "x-dev-user": "tester" } },
        fixture.bindings,
      );
      assert.equal(interrupted.status, 500);
      const capture = fixture.sqlite
        .prepare("SELECT status,workflow_instance_id FROM bottle_captures")
        .get();
      assert.equal(capture?.["status"], "queued");
      const owner = capture["workflow_instance_id"];
      assert.notEqual(owner, "old");
      assert.deepEqual(fixture.launches, []);
      if (continuation === "retry") {
        const response = await app.request(
          "http://localhost/bottle-captures/capture/retry",
          { method: "POST", headers: { "x-dev-user": "tester" } },
          fixture.bindings,
        );
        assert.equal(response.status, 200);
      } else {
        await startQueuedCaptureWorkflows({
          database: fixture.input.database,
          workflow: fixture.bindings.BOTTLE_CAPTURE_WORKFLOW,
        });
      }
      assert.deepEqual(fixture.launches, [owner]);
      assert.equal(
        fixture.sqlite.prepare("SELECT workflow_instance_id FROM bottle_captures").get()?.[
          "workflow_instance_id"
        ],
        owner,
      );
    }
  });
});

function batchBinding(
  createBatch: (input: {
    readonly instances: readonly { readonly id?: string }[];
  }) => Promise<unknown>,
): Pick<Workflow, "createBatch"> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The fixture returns the documented object-form Workflow createBatch results.
  return { createBatch } as unknown as Pick<Workflow, "createBatch">;
}
