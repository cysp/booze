import { createHash } from "node:crypto";

type Upload = {
  readonly key: string;
  readonly uploadId: string;
  readonly options: R2MultipartOptions;
  state: "pending" | "completed" | "aborted";
  bytes?: ArrayBuffer;
  etag?: string;
};
type UploadHook = (upload: Upload) => void | Promise<void>;

function missing(operation: string): never {
  throw new Error(`${operation}: The specified multipart upload does not exist. (10024)`);
}

// Independently models R2's single-use upload identity: abortion and completion
// compete for one terminal state, even when a caller has already sent a request.
export function multipartBucket(
  hooks: {
    readonly beforeCreate?: () => void | Promise<void>;
    readonly beforePart?: UploadHook;
    readonly beforeComplete?: UploadHook;
    readonly afterComplete?: UploadHook;
    readonly beforeAbort?: UploadHook;
    readonly beforeDelete?: () => void | Promise<void>;
  } = {},
): {
  readonly bucket: R2Bucket;
  readonly objects: Map<string, ArrayBuffer>;
  readonly uploads: Map<string, Upload>;
  readonly counts: Record<"created" | "parts" | "completed" | "aborted" | "deletes", number>;
} {
  const objects = new Map<string, ArrayBuffer>();
  const metadata = new Map<string, R2MultipartOptions>();
  const uploads = new Map<string, Upload>();
  const counts = { created: 0, parts: 0, completed: 0, aborted: 0, deletes: 0 };
  function object(key: string) {
    const bytes = objects.get(key);
    return bytes === undefined
      ? null
      : {
          key,
          size: bytes.byteLength,
          customMetadata: metadata.get(key)?.customMetadata ?? {},
          httpMetadata: metadata.get(key)?.httpMetadata ?? {},
        };
  }
  function handle(key: string, uploadId: string) {
    return {
      key,
      uploadId,
      async uploadPart(partNumber: number, bytes: ArrayBuffer) {
        const upload = uploads.get(uploadId);
        if (upload === undefined || upload.state !== "pending") missing("uploadPart");
        await hooks.beforePart?.(upload);
        if (upload.state !== "pending") missing("uploadPart");
        upload.bytes = bytes.slice(0);
        upload.etag = createHash("sha256").update(new Uint8Array(bytes)).digest("hex");
        counts.parts += 1;
        return { partNumber, etag: upload.etag };
      },
      async complete(parts: R2UploadedPart[]) {
        const upload = uploads.get(uploadId);
        if (upload === undefined || upload.state !== "pending") missing("completeMultipartUpload");
        await hooks.beforeComplete?.(upload);
        if (upload.state !== "pending") missing("completeMultipartUpload");
        if (upload.bytes === undefined || parts.length !== 1 || parts[0]?.etag !== upload.etag) {
          throw new Error("Invalid multipart part list");
        }
        upload.state = "completed";
        objects.set(key, upload.bytes);
        metadata.set(key, upload.options);
        counts.completed += 1;
        await hooks.afterComplete?.(upload);
        return object(key);
      },
      async abort() {
        const upload = uploads.get(uploadId);
        if (upload !== undefined) {
          await hooks.beforeAbort?.(upload);
          if (upload.state === "pending") upload.state = "aborted";
        }
        counts.aborted += 1;
      },
    };
  }
  const implementation = {
    async createMultipartUpload(key: string, options: R2MultipartOptions = {}) {
      await hooks.beforeCreate?.();
      const uploadId = crypto.randomUUID();
      uploads.set(uploadId, { key, uploadId, options, state: "pending" });
      counts.created += 1;
      return handle(key, uploadId);
    },
    resumeMultipartUpload: handle,
    async head(key: string) {
      return object(key);
    },
    async get(key: string) {
      const bytes = objects.get(key);
      return bytes === undefined
        ? null
        : {
            ...object(key),
            body: new Blob([bytes]).stream(),
            arrayBuffer: async () => bytes.slice(0),
          };
    },
    async delete(keys: string | string[]) {
      await hooks.beforeDelete?.();
      for (const key of typeof keys === "string" ? [keys] : keys) {
        counts.deletes += 1;
        objects.delete(key);
        metadata.delete(key);
      }
    },
    // Legacy path retained only to reproduce the unfenced PUT regression.
    async put(key: string, bytes: ArrayBuffer, options: R2MultipartOptions = {}) {
      const upload: Upload = { key, uploadId: "unfenced-put", options, state: "pending", bytes };
      await hooks.beforeComplete?.(upload);
      objects.set(key, bytes);
      metadata.set(key, options);
      await hooks.afterComplete?.(upload);
      return object(key);
    },
  };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Test bucket implements the image/multipart operations used by capture intake and deletion.
  return { bucket: implementation as unknown as R2Bucket, objects, uploads, counts };
}
