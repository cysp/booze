import assert from "node:assert/strict";
import { it } from "node:test";
import { HTTPException } from "hono/http-exception";
import { readRequestJson } from "./api/request-body.ts";

function request(body: BodyInit, headers?: HeadersInit): Request {
  const init = {
    method: "POST",
    body,
    ...(headers === undefined ? {} : { headers }),
    // Node's native Request requires duplex for a streaming body.
    duplex: "half",
  };
  return new Request("https://booze.test/api/bottles", init);
}

await it("accepts bounded JSON including non-ASCII catalogue text", async () => {
  assert.deepEqual(await readRequestJson(request('{"name":"Étage 🍷"}')), { name: "Étage 🍷" });
  const exact = JSON.stringify("a".repeat(512 * 1024 - 2));
  assert.equal(await readRequestJson(request(exact)), "a".repeat(512 * 1024 - 2));
});

await it("rejects malformed JSON and invalid UTF-8 as client input errors", async () => {
  for (const body of ["{", "", new Uint8Array([0xff])]) {
    await assert.rejects(
      readRequestJson(request(body)),
      (error) => error instanceof HTTPException && error.status === 400,
    );
  }
});

await it("bounds streamed bytes without trusting a small Content-Length", async () => {
  let pulls = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      controller.enqueue(new Uint8Array(128 * 1024).fill(32));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    readRequestJson(request(body, { "content-length": "1" })),
    (error) => error instanceof HTTPException && error.status === 413,
  );
  assert.equal(cancelled, true);
  assert.ok(pulls <= 6, `Read ${pulls} chunks from an unbounded body`);
});

await it("counts UTF-8 bytes rather than JavaScript characters", async () => {
  await assert.rejects(
    readRequestJson(request(JSON.stringify("🍷".repeat(140_000)))),
    (error) => error instanceof HTTPException && error.status === 413,
  );
});
