import { createHash, randomUUID } from "node:crypto";
import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const MiB = 1024 * 1024;
export const MAX_INPUT_SIZE = 5 * MiB;
export const MAX_INPUT_TOTAL = 16 * MiB;
export const MAX_MEDIA_SIZE = 16 * MiB;
export const MAX_FILES = 4;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SHA256 = /^[0-9a-f]{64}$/;
export const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

const formats = {
  "image/png": { kind: "image", demuxer: "png_pipe", codecs: ["png"] },
  "image/jpeg": { kind: "image", demuxer: "jpeg_pipe", codecs: ["mjpeg"] },
  "image/webp": { kind: "image", demuxer: "webp_pipe", codecs: ["webp"] },
  "video/mp4": { kind: "video", demuxer: "mov", codecs: null },
  "video/webm": { kind: "video", demuxer: "matroska", codecs: ["vp8", "vp9", "av1"] },
};

export class BridgeError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function invalidMedia() {
  return new BridgeError(502, "MEDIA_INVALID", "The bridge did not produce verified final media for this request.");
}

function invalidInput() {
  return new BridgeError(422, "INPUT_IMAGE_INVALID", "Expected a valid PNG, JPEG or WebP image of up to 5 MiB.");
}

export function mediaFormat(mime) {
  return Object.hasOwn(formats, mime) ? formats[mime] : null;
}

function verifiedSignature(bytes, mime) {
  if (bytes.length < 16) return false;
  switch (mime) {
    case "image/png":
      return bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
        && bytes.toString("ascii", 12, 16) === "IHDR" && bytes.subarray(-8, -4).toString("ascii") === "IEND";
    case "image/jpeg":
      return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
        && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9;
    case "image/webp":
      return bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP"
        && bytes.readUInt32LE(4) === bytes.length - 8;
    case "video/mp4":
      return bytes.toString("ascii", 4, 8) === "ftyp" && bytes.readUInt32BE(0) >= 16
        && bytes.readUInt32BE(0) <= bytes.length
        && /^(?:iso[2-9m]|mp4[12]|avc1|dash|cmf[cs]|M4V )$/.test(bytes.toString("ascii", 8, 12));
    case "video/webm":
      return bytes.readUInt32BE(0) === 0x1a45dfa3
        && bytes.subarray(4, 128).includes(Buffer.from([0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]));
    default:
      return false;
  }
}

export async function readImageUpload(request) {
  const mime = request.headers["content-type"]?.split(";")[0].trim().toLowerCase();
  const declared = Number(request.headers["content-length"]);
  if (mediaFormat(mime)?.kind !== "image" || declared > MAX_INPUT_SIZE) {
    request.resume();
    throw invalidInput();
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size <= MAX_INPUT_SIZE) chunks.push(chunk);
      else {
        chunks.length = 0;
        reject(invalidInput());
      }
    });
    request.on("end", () => {
      if (size > 0 && size <= MAX_INPUT_SIZE) resolve({ mime, bytes: Buffer.concat(chunks, size) });
      else reject(invalidInput());
    });
    request.on("error", reject);
    request.on("aborted", () => reject(invalidInput()));
  });
}

export function createMediaStore(root, { objects, quota = 2 * 1024 ** 3, ttlMs = 7 * 86_400_000 } = {}) {
  const assets = new Map();
  let used = 0;
  let reserved = 0;
  if (objects) {
    for (const folder of ["input", "output"]) {
      const target = directory(folder);
      for (const name of fs.readdirSync(target).filter((item) => item.endsWith(".json"))) {
        const metadata = JSON.parse(fs.readFileSync(path.join(target, name), "utf8"));
        assets.set(metadata.id, { folder, metadata });
        used += metadata.size;
      }
    }
  }
  let expiring = false;
  async function prune() {
    if (expiring) return;
    expiring = true;
    try {
      for (const { folder, metadata } of assets.values()) {
        if (metadata.expires_at <= Date.now()) await remove(folder, metadata.id);
      }
    } finally { expiring = false; }
  }
  async function remove(folder, id) {
    if (objects) await objects.remove(folder, id);
    fs.rmSync(path.join(root, folder, id + ".json"), { force: true });
    fs.rmSync(path.join(root, folder, id + ".bin"), { force: true });
    if (assets.has(id)) used -= assets.get(id).metadata.size;
    assets.delete(id);
  }
  if (objects) {
    const timer = setInterval(() => prune().catch(() => {}), 60_000);
    timer.unref();
  }
  let toolsAvailable;
  let activeValidations = 0;

  function requireValidator() {
    toolsAvailable ??= ["ffprobe", "ffmpeg"].every((tool) => (
      spawnSync(tool, ["-version"], { stdio: "ignore", timeout: 3000, windowsHide: true }).status === 0
    ));
    if (!toolsAvailable) throw new BridgeError(503, "MEDIA_VALIDATOR_UNAVAILABLE", "Install FFmpeg and ffprobe on the bridge host.");
  }

  function directory(name) {
    const folder = path.join(root, name);
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    return folder;
  }

  function writeJson(folder, id, value) {
    const file = path.join(directory(folder), id + ".json");
    const temporary = file + "." + randomUUID() + ".tmp";
    try {
      const fd = fs.openSync(temporary, "wx", 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(value));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temporary, file);
      if (process.platform !== "win32") {
        const dir = fs.openSync(path.dirname(file), "r");
        try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
      }
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  async function validateBytes(file, format, failure) {
    requireValidator();
    if (activeValidations >= 4) throw new BridgeError(429, "QUEUE_FULL", "The media validator is busy.");
    activeValidations++;
    const demuxer = ["-protocol_whitelist", "file", "-f", format.demuxer];
    if (format.demuxer === "mov") demuxer.push("-enable_drefs", "0", "-use_absolute_path", "0");
    const options = { timeout: 20_000, maxBuffer: 128 * 1024, windowsHide: true };
    try {
      const { stdout } = await exec("ffprobe", [
        "-v", "error", "-max_alloc", "134217728", ...demuxer,
        "-select_streams", "V:0", "-show_entries", "stream=index,codec_name,width,height",
        "-of", "json", file,
      ], options);
      const stream = JSON.parse(stdout).streams?.[0];
      if (!stream || !(stream.width > 0 && stream.height > 0)
        || stream.width * stream.height > 16_777_216
        || (format.codecs && !format.codecs.includes(stream.codec_name))) throw failure;
      const decoded = await exec("ffmpeg", [
        "-nostdin", "-v", "error", "-xerror", "-err_detect", "explode", "-max_alloc", "134217728",
        "-threads", "1", ...demuxer, "-i", file, "-map", `0:${stream.index}`,
        "-an", "-progress", "pipe:1", "-f", "null", "-",
      ], options);
      if (!/^frame=[1-9][0-9]*\s*$/m.test(decoded.stdout)) throw failure;
    } catch {
      throw failure;
    } finally {
      activeValidations--;
    }
  }

  async function save(folder, bytes, mime, expectedSha, taskId, owner) {
    const input = folder === "input";
    const failure = input ? invalidInput() : invalidMedia();
    const format = mediaFormat(mime);
    if (!format || (input && format.kind !== "image") || bytes.length > (input ? MAX_INPUT_SIZE : MAX_MEDIA_SIZE)
      || !verifiedSignature(bytes, mime)) throw failure;
    const sha256 = digest(bytes);
    if (!input && sha256 !== expectedSha) throw failure;
    const id = randomUUID();
    const file = path.join(directory(folder), id + ".bin");
    if (objects && used + reserved + bytes.length > quota) {
      await prune();
      if (used + reserved + bytes.length > quota) throw new BridgeError(507, "STORAGE_QUOTA", "Media storage quota exceeded.");
    }
    reserved += bytes.length;
    let uploaded = false;
    try {
      fs.writeFileSync(file, bytes, { flag: "wx", mode: 0o600, flush: true });
      await validateBytes(file, format, failure);
      const metadata = { id, mime_type: mime, size: bytes.length, sha256 };
      const record = { ...metadata, ...(!input ? { kind: format.kind, taskId } : {}),
        ...(objects ? { owner, expires_at: Date.now() + ttlMs } : {}) };
      if (objects) {
        await objects.put(folder, record, bytes);
        uploaded = true;
      }
      writeJson(folder, id, record);
      if (objects) {
        assets.set(id, { folder, metadata: record });
        used += bytes.length;
        if (!input) fs.rmSync(file, { force: true });
      }
      return input ? metadata : record;
    } catch (error) {
      fs.rmSync(file, { force: true });
      if (uploaded) await objects.remove(folder, id).catch(() => {});
      if (error instanceof BridgeError) throw error;
      throw new BridgeError(500, "STORAGE_ERROR", "Unable to save media on the bridge host.");
    } finally { reserved -= bytes.length; }
  }

  function bytesValid(bytes, metadata) {
    return bytes && bytes.length === metadata.size && digest(bytes) === metadata.sha256 && verifiedSignature(bytes, metadata.mime_type);
  }

  async function readOutput(id, owner) {
    if (!objects) return read("output", id);
    const entry = assets.get(id);
    if (!entry || entry.folder !== "output" || entry.metadata.owner !== owner || entry.metadata.expires_at <= Date.now()) return null;
    const bytes = await objects.get("output", entry.metadata);
    return bytesValid(bytes, entry.metadata) ? { bytes, metadata: entry.metadata } : null;
  }

  function read(folder, id, owner) {
    if (typeof id !== "string" || !UUID.test(id)) return null;
    try {
      const metadata = JSON.parse(fs.readFileSync(path.join(root, folder, id + ".json"), "utf8"));
      if (objects && (metadata.owner !== owner || metadata.expires_at <= Date.now())) return null;
      const file = path.join(root, folder, id + ".bin");
      if (fs.statSync(file).size !== metadata.size || metadata.size > MAX_MEDIA_SIZE) return null;
      const bytes = fs.readFileSync(file);
      return bytesValid(bytes, metadata) ? { metadata, bytes } : null;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  function restoreTasks() {
    const folder = path.join(root, "tasks");
    if (!fs.existsSync(folder)) return [];
    return fs.readdirSync(folder).filter((name) => name.endsWith(".json")).map((name) => (
      JSON.parse(fs.readFileSync(path.join(folder, name), "utf8"))
    ));
  }

  return {
    requireValidator,
    saveInput: (bytes, mime, owner) => save("input", bytes, mime, undefined, undefined, owner),
    saveOutput: (bytes, mime, sha256, taskId, owner) => save("output", bytes, mime, sha256, taskId, owner),
    readInput: (id, owner) => read("input", id, owner),
    readOutput,
    removeOutput: (id) => remove("output", id),
    usage: () => objects ? { bytes: used, quota_bytes: quota, retention_seconds: ttlMs / 1000 } : null,
    saveTask: (task) => writeJson("tasks", task.task_id, task),
    restoreTasks,
  };
}
