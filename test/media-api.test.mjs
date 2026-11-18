import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { crc32 } from "node:zlib";
import test from "node:test";

const exec = promisify(execFile);
const API_KEY = "test-macflow-key";
const TOKEN = "test-bridge-token";
const auth = { authorization: `Bearer ${API_KEY}` };
const SHA = (value) => createHash("sha256").update(value).digest("hex");

async function freePort() {
  const probe = net.createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address();
  await promisify(probe.close.bind(probe))();
  return port;
}

async function waitFor(check) {
  for (let i = 0; i < 250; i++) {
    const value = await check();
    if (value) return value;
    await delay(20);
  }
  assert.fail("Timed out waiting for bridge state");
}

async function start(context, dataDir) {
  const port = await freePort();
  const child = spawn(process.execPath, ["local-server.mjs", `--port=${port}`, `--token=${TOKEN}`], {
    env: { ...process.env, BRIDGE_API_KEY: API_KEY, BRIDGE_DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const done = once(child, "exit");
    child.kill();
    await done;
  };
  context.after(stop);
  await waitFor(() => {
    if (child.exitCode !== null) assert.fail(output);
    return output.includes("AI Bridge listening");
  });
  const request = (route, options = {}, headers = auth) => fetch(`http://127.0.0.1:${port}${route}`, {
    ...options, headers: { ...headers, ...options.headers },
  });
  const json = (route, data, options = {}) => request(route, {
    ...options, method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data),
  });
  return {
    port, request, json, stop, output: () => output,
    status: () => request("/api/bridge/status").then((response) => response.json()),
    task: (id) => request(`/v1/media/tasks/${id}`).then((response) => response.json()),
    chat: (data, options) => json("/v1/chat/completions", data, options),
    submit: (data, requestId) => json("/v1/media/tasks", { ...data, client_request_id: requestId }),
  };
}

function tab(provider = "chatgpt", options = {}) {
  return {
    tabId: 42, documentToken: randomUUID(), title: "Fixture Tab",
    provider, url: provider === "chatgpt" ? "https://chatgpt.com/" : "https://grok.com/imagine",
    ready: true, busy: false, outputKinds: ["text", "image", "video"], input_image_support: true,
    ...options,
  };
}

async function connect(context, bridge, tabs, profileInstanceId = randomUUID()) {
  const socket = new WebSocket(`ws://127.0.0.1:${bridge.port}/bridge?token=${TOKEN}`);
  context.after(() => socket.close());
  const inbox = [];
  socket.addEventListener("message", (event) => inbox.push(JSON.parse(event.data)));
  await once(socket, "open");
  const send = (message) => socket.send(JSON.stringify(message));
  const update = (items) => send({ type: "bridge:status", tabs: items });
  send({ type: "bridge:hello", version: "0.6.0", mediaProtocol: 1, profileInstanceId, providers: ["chatgpt", "grok"] });
  update(tabs);
  await waitFor(async () => (await bridge.status()).tabs.some((item) => item.profileInstanceId === profileInstanceId));
  const messageFor = (run, type, fields = {}) => send({ type, id: run.id, target: run.target, ...fields });
  return {
    inbox, send, update, socket, profileInstanceId,
    nextRun: (index = 0) => waitFor(() => inbox.filter((message) => message.type === "bridge:run")[index]),
    async submitted(run, attachments = []) {
      messageFor(run, "bridge:submitted", { input_images: attachments });
      await waitFor(() => inbox.some((message) => message.type === "bridge:permit" && message.id === run.id));
    },
    error: (run, code, phase) => messageFor(run, "bridge:error", { code, phase }),
    complete(run, files = [], options = {}) {
      const media = files.map(({ bytes, mime, sha256, kind }, index) => {
        for (let offset = 0; offset < bytes.length; offset += 192 * 1024) {
          messageFor(run, "bridge:media-chunk", { index, offset, data: bytes.subarray(offset, offset + 192 * 1024).toString("base64") });
        }
        return { mime_type: mime, size: bytes.length, sha256: sha256 ?? SHA(bytes), kind: kind ?? mime.split("/")[0] };
      });
      messageFor(run, "bridge:complete", { text: "Fixture complete", media, ...options });
    },
  };
}

function payload(peer, item, kind = "image", extra = {}) {
  const { tabId, documentToken, url } = item;
  return {
    model: `bridge-${item.provider}`, stream: false, media_kind: kind,
    target: { profileInstanceId: peer.profileInstanceId, tabId, documentToken, url },
    messages: [{ role: "user", content: "Generate media for the test fixture." }],
    input_images: [],
    ...extra,
  };
}

async function expectError(response, status, code) {
  const error = await response.json();
  assert.equal(response.status, status, JSON.stringify(error));
  assert.equal(error.error.code, code);
}

async function sample(directory, mime, color = "red") {
  const extension = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "video/mp4": "mp4", "video/webm": "webm" }[mime];
  const file = path.join(directory, randomUUID() + "." + extension);
  const options = mime.startsWith("image") ? ["-frames:v", "1", "-update", "1"]
    : ["-frames:v", "3", "-an", "-c:v", extension === "mp4" ? "libx264" : "libvpx-vp9"];
  await exec("ffmpeg", [
    "-nostdin", "-v", "error", "-f", "lavfi", "-i", `color=${color}:s=96x96:r=10`,
    ...options, "-threads", "1", file,
  ]);
  return { mime, bytes: await fs.readFile(file) };
}

async function workspace(context) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ai-bridge-media-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test("authenticates the API and inventories exact profiles, documents, capabilities and queue reservations", { timeout: 30_000 }, async (t) => {
  const bridge = await start(t, await workspace(t));
  const first = tab("chatgpt", { url: "https://chatgpt.com/c/chat" });
  const limited = tab("grok", { documentToken: randomUUID(), ready: true, outputKinds: ["text"], input_image_support: false });
  const peer = await connect(t, bridge, [first]);
  const other = await connect(t, bridge, [limited]);
  await expectError(await bridge.request("/api/bridge/status", {}, {}), 401, "INVALID_API_KEY");
  await expectError(await bridge.request("/v1/models", {}, { authorization: "Bearer wrong" }), 401, "INVALID_API_KEY");
  const models = await (await bridge.request("/v1/models")).json();
  assert.deepEqual(models.data.find((entry) => entry.id === "bridge-chatgpt"), {
    id: "bridge-chatgpt", object: "model", owned_by: "ai-bridge", created: 0,
  });
  const status = await bridge.status();
  assert.deepEqual(status, {
    connected_extensions: 2, extension_versions: ["0.6.0", "0.6.0"],
    providers: models.data.filter((model) => model.id !== "bridge-auto").map(({ id }) => (
      status.providers.find((item) => item.id === id.slice(7))
    )),
    tabs: [{ ...first, profileInstanceId: peer.profileInstanceId }, { ...limited, profileInstanceId: other.profileInstanceId }],
    input_image_support: true, active_request: null, queued_requests: 0,
  });
  assert.ok(status.providers.some((provider) => provider.id === "chatgpt" && provider.label === "ChatGPT"));
  assert.doesNotMatch(JSON.stringify(status) + bridge.output(), new RegExp(`${API_KEY}|${TOKEN}`));
  const valid = payload(peer, first, "none");
  await expectError(await bridge.chat({ ...valid, target: { ...valid.target, tabId: 666 } }), 409, "TAB_STALE");
  await expectError(await bridge.chat({ ...valid, target: { ...valid.target, url: "https://chatgpt.com/c/other" } }), 409, "TAB_STALE");
  await expectError(await bridge.chat({ ...valid, model: "bridge-grok" }), 409, "TAB_PROVIDER_MISMATCH");
  await expectError(await bridge.chat(payload(other, limited, "video")), 409, "TAB_UNSUPPORTED");

  const pending = bridge.chat(valid);
  const run = await peer.nextRun();
  assert.deepEqual(run.target, valid.target);
  assert.equal(other.inbox.filter((entry) => entry.type === "bridge:run").length, 0);
  assert.equal((await bridge.status()).tabs[0].busy, true);
  await expectError(await bridge.chat(valid), 409, "TAB_BUSY");
  const queuedPayload = payload(other, limited, "none");
  const queued = await bridge.submit(queuedPayload, "queued-in-other-profile");
  assert.equal(queued.status, 202);
  const queuedTask = await queued.json();
  assert.equal((await bridge.status()).queued_requests, 1);

  const newDocument = { ...first, documentToken: randomUUID() };
  peer.update([newDocument]);
  await expectError(await pending, 409, "TAB_STALE");
  await expectError(await bridge.chat(valid), 409, "TAB_STALE");
  const otherRun = await other.nextRun();
  assert.equal(otherRun.id, queuedTask.task_id);
  await other.submitted(otherRun);
  other.complete(otherRun);
  assert.equal((await waitFor(async () => {
    const task = await bridge.task(queuedTask.task_id);
    return task.status === "completed" && task;
  })).content, "Fixture complete");
  const closed = once(peer.socket, "close");
  peer.socket.close();
  await closed;
  await waitFor(async () => (await bridge.status()).connected_extensions === 1);
  await expectError(await bridge.chat(payload(peer, newDocument)), 503, "EXTENSION_OFFLINE");
});

test("stores reference uploads and returns verifiable PNG, JPEG, WebP, MP4 and WebM bytes", { timeout: 40_000 }, async (t) => {
  const directory = await workspace(t);
  const bridge = await start(t, directory);
  const item = tab();
  const peer = await connect(t, bridge, [item]);
  const samples = await Promise.all(["image/png", "image/jpeg", "image/webp", "video/mp4", "video/webm"]
    .map((mime) => sample(directory, mime)));
  const upload = (file) => bridge.request("/v1/input-images", { method: "POST", headers: { "content-type": file.mime }, body: file.bytes });
  const images = [];
  for (const file of samples.slice(0, 3)) {
    const response = await upload(file);
    assert.equal(response.status, 201, await response.clone().text());
    const metadata = await response.json();
    assert.match(metadata.id, /^[\w-]{36}$/);
    assert.deepEqual(metadata, { id: metadata.id, mime_type: file.mime, size: file.bytes.length, sha256: SHA(file.bytes) });
    images.push(metadata);
  }
  await expectError(await upload({ ...samples[0], mime: "image/jpeg" }), 422, "INPUT_IMAGE_INVALID");
  await expectError(await upload({ ...samples[0], bytes: Buffer.alloc(5 * 1024 * 1024 + 1) }), 422, "INPUT_IMAGE_INVALID");
  await expectError(await upload({ ...samples[0], bytes: samples[0].bytes.subarray(0, 32) }), 422, "INPUT_IMAGE_INVALID");
  await expectError(await bridge.chat(payload(peer, item, "image", { input_images: [randomUUID()] })), 422, "INPUT_IMAGE_INVALID");
  await expectError(await bridge.chat(payload(peer, item, "image", { input_images: Array(5).fill(images[0].id) })), 422, "INPUT_IMAGE_INVALID");
  const padding = Buffer.alloc(4.25 * 1024 * 1024 + 12);
  padding.writeUInt32BE(padding.length - 12, 0);
  padding.write("raNd", 4);
  padding.writeUInt32BE(crc32(padding.subarray(4, -4)), padding.length - 4);
  const original = samples[0].bytes;
  const large = await upload({ ...samples[0], bytes: Buffer.concat([original.subarray(0, -12), padding, original.subarray(-12)]) });
  assert.equal(large.status, 201);
  const largeImage = await large.json();
  await expectError(await bridge.chat(payload(peer, item, "image", { input_images: Array(4).fill(largeImage.id) })), 422, "INPUT_IMAGE_INVALID");

  for (const [index, file] of samples.entries()) {
    const mediaKind = file.mime.split("/")[0];
    const ordered = index === 0 ? [...images].reverse() : [];
    const response = bridge.chat(payload(peer, item, mediaKind, { input_images: ordered.map(({ id }) => id) }));
    const run = await peer.nextRun(index);
    assert.deepEqual(run.input_images.map(({ id, sha256 }) => ({ id, sha256 })), ordered.map(({ id, sha256 }) => ({ id, sha256 })));
    for (const image of run.input_images) assert.equal(SHA(Buffer.from(image.data, "base64")), image.sha256);
    await peer.submitted(run, ordered.map(({ id, sha256 }) => ({ id, sha256 })));
    peer.complete(run, [file]);
    const result = await response;
    assert.equal(result.status, 200, await result.clone().text());
    const completed = await result.json();
    assert.equal(completed.choices[0].message.content, "Fixture complete");
    const [media] = completed.media;
    assert.deepEqual(media, { id: media.id, kind: mediaKind, mime_type: file.mime, size: file.bytes.length, sha256: SHA(file.bytes) });
    await expectError(await bridge.request(`/v1/media/${media.id}`, {}, {}), 401, "INVALID_API_KEY");
    const download = await bridge.request(`/v1/media/${media.id}`);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get("content-type"), file.mime);
    assert.equal(Number(download.headers.get("content-length")), file.bytes.length);
    assert.equal(download.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), file.bytes);
    if (index === 0) {
      await fs.writeFile(path.join(directory, "output", media.id + ".bin"), Buffer.alloc(media.size));
      await expectError(await bridge.request(`/v1/media/${media.id}`), 404, "MEDIA_NOT_FOUND");
    }
  }
});

test("refuses missing, old and invalid media, unverified attachments, and cross-request frames", { timeout: 35_000 }, async (t) => {
  const directory = await workspace(t);
  const bridge = await start(t, directory);
  const item = tab();
  const peer = await connect(t, bridge, [item]);
  const png = await sample(directory, "image/png");
  const post = (kind = "image", extra) => bridge.chat(payload(peer, item, kind, extra));
  const startRun = async (index, kind) => {
    const response = post(kind);
    const run = await peer.nextRun(index);
    await peer.submitted(run);
    return { response, run };
  };

  const missing = await startRun(0);
  peer.complete(missing.run);
  await expectError(await missing.response, 502, "MEDIA_INVALID");
  const wrongMime = await startRun(1);
  peer.complete(wrongMime.run, [{ ...png, mime: "image/jpeg" }]);
  await expectError(await wrongMime.response, 502, "MEDIA_INVALID");
  const wrongHash = await startRun(2);
  peer.complete(wrongHash.run, [{ ...png, sha256: "0".repeat(64) }]);
  await expectError(await wrongHash.response, 502, "MEDIA_INVALID");
  const wrongKind = await startRun(3, "video");
  peer.complete(wrongKind.run, [png]);
  await expectError(await wrongKind.response, 502, "MEDIA_INVALID");
  const audioOnly = await startRun(4, "video");
  const audio = path.join(directory, "audio.mp4");
  await exec("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.1", "-c:a", "aac", audio]);
  peer.complete(audioOnly.run, [{ mime: "video/mp4", bytes: await fs.readFile(audio) }]);
  await expectError(await audioOnly.response, 502, "MEDIA_INVALID");
  const good = await startRun(5);
  peer.complete(missing.run, [png]);
  peer.complete({ ...good.run, target: { ...good.run.target, documentToken: randomUUID() } }, [png]);
  peer.complete(good.run, [png]);
  assert.equal((await good.response).status, 200);
  const duplicate = await startRun(6);
  peer.complete(duplicate.run, [png]);
  await expectError(await duplicate.response, 502, "MEDIA_INVALID");

  const image = await (await bridge.request("/v1/input-images", {
    method: "POST", body: png.bytes, headers: { "content-type": png.mime },
  })).json();
  const invalidAck = post("image", { input_images: [image.id] });
  const pending = await peer.nextRun(7);
  peer.send({ type: "bridge:submitted", id: pending.id, target: pending.target, input_images: [{ id: image.id, sha256: "f".repeat(64) }] });
  await expectError(await invalidAck, 422, "INPUT_IMAGE_INVALID");
  assert.ok(!peer.inbox.some((message) => message.type === "bridge:permit" && message.id === pending.id));
});

test("deduplicates tasks across polling, connection loss and a server restart", { timeout: 30_000 }, async (t) => {
  const directory = await workspace(t);
  let bridge = await start(t, directory);
  const item = tab();
  let peer = await connect(t, bridge, [item]);
  const body = payload(peer, item, "image");
  const response = await bridge.submit(body, "macflow-lost-response");
  assert.equal(response.status, 202);
  const { task_id } = await response.json();
  const run = await peer.nextRun();
  await peer.submitted(run);
  assert.equal((await bridge.task(task_id)).status, "running");
  const retry = await bridge.submit(body, "macflow-lost-response");
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).task_id, task_id);
  await expectError(await bridge.submit({ ...body, messages: [{ role: "user", content: "different" }] }, "macflow-lost-response"), 409, "REQUEST_ID_CONFLICT");

  const queuedTab = { ...item, tabId: 92, documentToken: randomUUID() };
  peer.update([item, queuedTab]);
  await waitFor(async () => (await bridge.status()).tabs.length === 2);
  const queued = await (await bridge.submit(payload(peer, queuedTab), "queued-task")).json();
  const cancelled = await bridge.request(`/v1/media/tasks/${queued.task_id}`, { method: "DELETE" });
  assert.equal((await cancelled.json()).status, "cancelled");

  const closed = once(peer.socket, "close");
  peer.socket.close();
  await closed;
  assert.equal((await waitFor(async () => {
    const task = await bridge.task(task_id);
    return task.status === "unknown" && task;
  })).error.code, "TASK_UNKNOWN");
  const profileId = peer.profileInstanceId;
  await bridge.stop();
  bridge = await start(t, directory);
  peer = await connect(t, bridge, [item], profileId);
  assert.equal((await bridge.task(task_id)).status, "unknown");
  assert.equal((await bridge.task(queued.task_id)).status, "cancelled");
  assert.equal((await (await bridge.submit(body, "macflow-lost-response")).json()).task_id, task_id);
  await expectError(await bridge.chat(body), 409, "TAB_BUSY");
  assert.equal(peer.inbox.filter((message) => message.type === "bridge:run").length, 0);

  const fresh = { ...item, documentToken: randomUUID() };
  peer.update([fresh]);
  await waitFor(async () => (await bridge.status()).tabs[0]?.documentToken === fresh.documentToken);
  const freshBody = payload(peer, fresh);
  const next = await (await bridge.submit(freshBody, "new-request")).json();
  const freshRun = await peer.nextRun();
  await peer.submitted(freshRun);
  const png = await sample(directory, "image/png");
  peer.complete(freshRun, [png]);
  const complete = await waitFor(async () => {
    const task = await bridge.task(next.task_id);
    return task.status === "completed" && task;
  });
  assert.notEqual(next.task_id, task_id);
  await bridge.stop();
  bridge = await start(t, directory);
  assert.deepEqual((await bridge.task(next.task_id)).media, complete.media);
  assert.equal((await bridge.task(task_id)).media, undefined);
  const file = await bridge.request(`/v1/media/${complete.media[0].id}`);
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), png.bytes);
  assert.equal((await bridge.task(randomUUID())).status, "unknown");
});

test("bounds the queue, rechecks queued targets, and keeps the original job after an HTTP abort", { timeout: 30_000 }, async (t) => {
  const bridge = await start(t, await workspace(t));
  const tabs = Array.from({ length: 12 }, (_, index) => tab("chatgpt", { tabId: index + 1 }));
  const peer = await connect(t, bridge, tabs);
  const signal = new AbortController();
  const pending = bridge.chat(payload(peer, tabs[0], "none"), { signal: signal.signal });
  const run = await peer.nextRun();
  await peer.submitted(run);
  signal.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal((await bridge.task(run.id)).status, "running");
  await expectError(await bridge.chat(payload(peer, tabs[0], "none")), 409, "TAB_BUSY");

  const queued = [];
  for (const item of tabs.slice(1, 11)) {
    const response = await bridge.submit(payload(peer, item, "none"), `queue-${item.tabId}`);
    assert.equal(response.status, 202);
    queued.push(await response.json());
  }
  assert.equal((await bridge.status()).queued_requests, 10);
  await expectError(await bridge.submit(payload(peer, tabs[11], "none"), "queue-full"), 429, "QUEUE_FULL");
  const reloaded = { ...tabs[1], documentToken: randomUUID() };
  peer.update([tabs[0], reloaded, ...tabs.slice(2)]);
  await waitFor(async () => (await bridge.status()).tabs.find((item) => item.tabId === reloaded.tabId)?.documentToken === reloaded.documentToken);
  peer.complete(run);
  await waitFor(async () => (await bridge.task(run.id)).status === "completed");
  assert.equal((await bridge.task(queued[0].task_id)).error.code, "TAB_STALE");
  const next = await peer.nextRun(1);
  assert.equal(next.id, queued[1].task_id);
});
