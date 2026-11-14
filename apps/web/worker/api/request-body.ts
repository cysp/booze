import { HTTPException } from "hono/http-exception";

const maximumJsonBytes = 512 * 1024;

// Enforce the limit while reading, including requests without Content-Length.
// The same bound covers HTTP catalogue writes and MCP JSON-RPC messages.
export async function readRequestBytes(request: Request): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body?.getReader();
  if (reader === undefined) return new Uint8Array();
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      const chunk: unknown = part.value;
      if (!(chunk instanceof Uint8Array)) {
        void cancelReader(reader);
        throw new HTTPException(400, { message: "Request body must contain bytes" });
      }
      size += chunk.byteLength;
      if (size > maximumJsonBytes) {
        void cancelReader(reader);
        throw new HTTPException(413, { message: "JSON request must not exceed 512 KiB" });
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function cancelReader(reader: ReadableStreamDefaultReader<unknown>): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // A rejected body must not mask the bounded-read error, or delay its response.
  }
}

export async function readRequestJson(request: Request): Promise<unknown> {
  const bytes = await readRequestBytes(request);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (cause) {
    throw new HTTPException(400, { cause, message: "Request body must be valid UTF-8 JSON" });
  }
}
