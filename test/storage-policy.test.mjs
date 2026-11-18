import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createMediaStore, digest } from "../media-store.mjs";

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aibr-storage-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const png = execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=red:s=8x8",
    "-frames:v", "1", "-c:v", "png", "-threads", "1", "-f", "image2pipe", "pipe:1"]);
  const blobs = new Map();
  const removed = [];
  const objects = {
    async put(folder, media, value) { blobs.set(media.id, value); },
    async get(folder, media) { return blobs.get(media.id); },
    async remove(folder, id) { removed.push(id); blobs.delete(id); },
  };
  return { root, png, blobs, objects, removed };
}

test("evicts oldest eligible blobs near 70% and preserves queued and downloading media", async (t) => {
  const { root, png, blobs, removed, objects } = workspace(t);
  const store = createMediaStore(root, { objects, quota: 5 * png.length });
  const queued = await store.saveInput(png, "image/png", "a");
  const releaseQueued = store.pin([queued.id]);
  const streaming = await store.saveOutput(png, "image/png", digest(png), randomUUID(), "a");
  const oldestEligible = await store.saveInput(png, "image/png", "b");
  let resumeRead;
  const original = objects.get;
  objects.get = (...args) => new Promise((resolve) => {
    resumeRead = () => resolve(original(...args));
  });
  const download = store.readOutput(streaming.id, "a");
  const latest = await store.saveInput(png, "image/png", "a");
  assert.deepEqual(removed, [oldestEligible.id]);
  assert.equal(store.readInput(oldestEligible.id, "b"), null);
  assert.deepEqual(store.readInput(queued.id, "a").bytes, png);
  assert.ok(blobs.has(latest.id));
  assert.equal(store.usage().bytes, 3 * png.length);
  assert.equal(store.usage().retention_seconds, 24 * 3600);
  assert.equal(store.usage().cleanup_percent, 70);
  resumeRead();
  assert.deepEqual((await download).bytes, png);
  releaseQueued();
  await store.saveInput(png, "image/png", "a");
  assert.deepEqual(removed, [oldestEligible.id, queued.id]);
});

test("shortens legacy expiry after restart and never deletes pinned data to exceed the hard quota", async (t) => {
  const { root, png, blobs, removed, objects } = workspace(t);
  const old = randomUUID();
  const folder = path.join(root, "input");
  fs.mkdirSync(folder);
  const metadata = path.join(folder, old + ".json");
  fs.writeFileSync(metadata, JSON.stringify({
    id: old, size: png.length, mime_type: "image/png", sha256: digest(png),
    owner: "a", expires_at: Date.now() + 6 * 86_400_000,
  }));
  const yesterday = new Date(Date.now() - 25 * 3600_000);
  fs.utimesSync(metadata, yesterday, yesterday);
  fs.writeFileSync(path.join(folder, old + ".bin"), png);
  blobs.set(old, png);
  const store = createMediaStore(root, { objects, quota: 2 * png.length });
  assert.equal(store.readInput(old, "a"), null);
  const first = await store.saveInput(png, "image/png", "a");
  const releaseFirst = store.pin([first.id]);
  const taskId = randomUUID();
  const releaseOutput = store.pin([taskId]);
  const output = await store.saveOutput(png, "image/png", digest(png), taskId, "a");
  await assert.rejects(store.saveInput(png, "image/png", "a"), { status: 507, code: "STORAGE_QUOTA" });
  assert.deepEqual(removed, [old]);
  assert.ok(blobs.has(output.id));
  assert.ok(blobs.has(first.id));
  releaseFirst();
  releaseOutput();
});
