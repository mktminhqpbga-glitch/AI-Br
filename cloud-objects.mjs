import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { BridgeError, MAX_MEDIA_SIZE } from "./media-store.mjs";

export function createCloudObjects(env) {
  const endpoint = new URL(env.BRIDGE_S3_ENDPOINT ?? "");
  const accessKeyId = env.BRIDGE_S3_ACCESS_KEY_ID;
  const secretAccessKey = env.BRIDGE_S3_SECRET_ACCESS_KEY;
  const Bucket = env.BRIDGE_S3_BUCKET;
  const prefix = env.BRIDGE_S3_PREFIX ?? "ai-br";
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || !accessKeyId || !secretAccessKey || !Bucket || !/^[\w/-]{1,120}$/.test(prefix)) {
    throw new Error("Configure the private HTTPS object store.");
  }
  const client = new S3Client({
    region: env.BRIDGE_S3_REGION ?? "auto", endpoint: endpoint.href, forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey }, maxAttempts: 2,
    requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED",
  });
  const options = () => ({ abortSignal: AbortSignal.timeout(30_000) });
  const key = (folder, id) => ({ Bucket, Key: prefix + "/" + folder + "/" + id });
  const failure = () => new BridgeError(502, "STORAGE_ERROR", "The private object store is unavailable.");
  return {
    async put(folder, metadata, bytes) {
      try {
        await client.send(new PutObjectCommand({
          ...key(folder, metadata.id), Body: bytes, ContentType: metadata.mime_type,
          Metadata: { sha256: metadata.sha256 }, CacheControl: "private, no-store",
        }), options());
      } catch { throw failure(); }
    },
    async get(folder, metadata) {
      try {
        const result = await client.send(new GetObjectCommand(key(folder, metadata.id)), options());
        if (!result.Body || result.ContentLength !== metadata.size || result.ContentLength > MAX_MEDIA_SIZE) {
          result.Body?.destroy();
          throw failure();
        }
        const chunks = [];
        let size = 0;
        for await (const chunk of result.Body) {
          size += chunk.length;
          if (size > metadata.size) throw failure();
          chunks.push(chunk);
        }
        return Buffer.concat(chunks, size);
      } catch (error) {
        if (error?.name === "NoSuchKey") return null;
        throw failure();
      }
    },
    async remove(folder, id) {
      try { await client.send(new DeleteObjectCommand(key(folder, id)), options()); }
      catch { throw failure(); }
    },
  };
}
