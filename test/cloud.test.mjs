import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID, webcrypto } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import vm from "node:vm";
import { chromium } from "playwright-core";
import WebSocket from "ws";
import { namespaceFor, openSharedState } from "../shared-state.mjs";

const exec = promisify(execFile);
const origin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const adminPass = "fixture-admin-password-for-cloud";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function waitFor(label, check) {
  for (let i = 0; i < 200; i++) {
    const result = await check();
    if (result) return result;
    await delay(25);
  }
  assert.fail("Timed out waiting for " + label);
}

async function bind(server, t) {
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    return new Promise((resolve) => server.close(resolve));
  });
  return server.address().port;
}

function httpsCall(base, ca, route, method, data, headers) {
  const bytes = data && (Buffer.isBuffer(data) ? data : Buffer.from(JSON.stringify(data)));
  return new Promise((resolve, reject) => {
    const request = https.request(base + route, {
      ca, method, headers: { ...(bytes ? { "Content-Type": "application/json", "Content-Length": bytes.length } : {}), ...headers },
    }, async (response) => {
      const chunks = [];
      for await (const chunk of response) chunks.push(chunk);
      const content = Buffer.concat(chunks);
      resolve({ status: response.statusCode, headers: response.headers, content, json: () => JSON.parse(content) });
    });
    request.on("error", reject);
    request.end(bytes);
  });
}

async function fixtures(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-br-cloud-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const certFile = path.join(dir, "cert.pem");
  const keyFile = path.join(dir, "key.pem");
  await exec("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
    "-addext", "subjectAltName=IP:127.0.0.1", "-out", certFile, "-keyout", keyFile]);
  const tls = { cert: await fs.readFile(certFile), key: await fs.readFile(keyFile) };
  const objects = new Map();
  const signatures = [];
  const storagePort = await bind(https.createServer(tls, async (request, response) => {
    signatures.push(request.headers.authorization?.startsWith("AWS4-HMAC-SHA256") ?? false);
    const key = new URL(request.url, "https://fixture.invalid").pathname;
    if (request.method === "PUT") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      objects.set(key, { bytes: Buffer.concat(chunks), type: request.headers["content-type"] });
      return response.writeHead(200).end();
    }
    if (request.method === "DELETE") {
      objects.delete(key);
      return response.writeHead(204).end();
    }
    const object = objects.get(key);
    if (!object) return response.writeHead(404, { "Content-Type": "application/xml" }).end("<Error><Code>NoSuchKey</Code></Error>");
    return response.writeHead(200, { "Content-Type": object.type, "Content-Length": object.bytes.length }).end(object.bytes);
  }), t);

  const probe = net.createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const upstream = probe.address().port;
  await promisify(probe.close.bind(probe))();
  const gateway = https.createServer(tls, (request, response) => {
    const forward = http.request({
      hostname: "127.0.0.1", port: upstream, method: request.method, path: request.url,
      headers: { ...request.headers, "x-forwarded-proto": "https", "x-forwarded-for": "192.0.2.18" },
    }, (result) => {
      response.writeHead(result.statusCode, result.headers);
      result.pipe(response);
    });
    forward.on("error", () => response.writeHead(502).end());
    request.pipe(forward);
  });
  gateway.on("upgrade", (request, socket, head) => {
    const forward = http.request({
      hostname: "127.0.0.1", port: upstream, path: request.url,
      headers: { ...request.headers, "x-forwarded-proto": "https" },
    });
    forward.on("response", (response) => socket.end("HTTP/1.1 " + response.statusCode + " Rejected\r\nConnection: close\r\n\r\n"));
    forward.on("upgrade", (response, connection, bytes) => {
      socket.write("HTTP/1.1 101 Switching Protocols\r\n" +
        Object.entries(response.headers).map(([name, value]) => name + ": " + value).join("\r\n") + "\r\n\r\n");
      if (bytes.length) socket.write(bytes);
      if (head.length) connection.write(head);
      connection.on("error", () => socket.destroy());
      socket.on("error", () => connection.destroy());
    connection.on("end", () => socket.destroy());
    socket.on("end", () => connection.destroy());
    connection.on("close", () => socket.destroy());
    socket.on("close", () => connection.destroy());
      socket.pipe(connection).pipe(socket);
    });
    forward.on("error", () => socket.destroy());
    forward.end();
  });
  const gatewayPort = await bind(gateway, t);
  const base = "https://127.0.0.1:" + gatewayPort;
  const root = path.join(dir, "data");
  const database = process.env.BRIDGE_TEST_STATE_DATABASE_URL;
  const stateEnv = database ? {
    BRIDGE_STATE_MODE: "postgres", BRIDGE_STATE_DATABASE_URL: database, BRIDGE_STATE_NAMESPACE: "test-" + randomUUID(),
  } : {};
  const caFile = path.join(dir, "trusted.pem");
  const extraCa = process.env.NODE_EXTRA_CA_CERTS;
  await fs.writeFile(caFile, extraCa ? Buffer.concat([tls.cert, await fs.readFile(extraCa)]) : tls.cert);
  let output = "";
  async function start() {
    const child = spawn(process.execPath, ["local-server.mjs"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env, ...stateEnv, BRIDGE_MODE: "cloud", PORT: String(upstream), BRIDGE_PUBLIC_URL: base,
        BRIDGE_UPDATE_URL: "https://updater.example.test",
        BRIDGE_DATA_DIR: root, BRIDGE_ADMIN_PASSWORD: adminPass,
        BRIDGE_S3_ENDPOINT: "https://127.0.0.1:" + storagePort, BRIDGE_S3_BUCKET: "fixture",
        BRIDGE_S3_ACCESS_KEY_ID: "fixture-storage-access", BRIDGE_S3_SECRET_ACCESS_KEY: "fixture-storage-secret",
        BRIDGE_S3_REGION: "us-east-1", NODE_EXTRA_CA_CERTS: caFile,
      },
    });
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const exited = once(child, "exit");
    let stopped = false;
    const stop = async () => {
      if (stopped) return;
      stopped = true;
      child.kill();
      await exited;
    };
    t.after(stop);
    await waitFor("cloud startup", async () => {
      if (child.exitCode !== null) assert.fail(output);
      return (await httpsCall(base, tls.cert, "/health", "GET")).status === 200;
    });
    return stop;
  }
  const stop = await start();
  return { dir, root, database, stateEnv, base, upstream, ca: tls.cert, objects, signatures, start, stop, output: () => output,
    http: (route, method = "GET", data, headers) => httpsCall(base, tls.cert, route, method, data, headers) };
}

async function login(host) {
  const response = await host.http("/admin/login", "POST", { password: adminPass }, { Origin: host.base });
  assert.equal(response.status, 200, response.content.toString());
  const cookie = response.headers["set-cookie"][0].split(";")[0];
  assert.match(response.headers["set-cookie"][0], /HttpOnly; Secure; SameSite=Strict/);
  const { csrf } = response.json();
  return (route, method = "GET", data) => host.http("/admin/" + route, method, data, { Cookie: cookie, "X-Bridge-CSRF": csrf });
}

async function connect(t, host, profile, credential, item) {
  const peer = new WebSocket(host.base.replace("https:", "wss:") + "/bridge", ["ai-bridge", "auth." + credential], {
    ca: host.ca, origin,
  });
  t.after(() => peer.terminate());
  const messages = [];
  peer.on("message", (message) => messages.push(JSON.parse(message)));
  await once(peer, "open");
  assert.equal(peer.protocol, "ai-bridge");
  const send = (message) => peer.send(JSON.stringify(message));
  send({ type: "bridge:hello", mediaProtocol: 1, version: "0.7.0", profileInstanceId: profile });
  send({ type: "bridge:status", tabs: [item] });
  return { peer, messages, send, run: (number = 0) => waitFor("dispatch", () => messages.filter((message) => message.type === "bridge:run")[number]),
    async submit(run) {
      const report = (type, extra = {}) => send({ type: "bridge:" + type, id: run.id, target: run.target, ...extra });
      report("received");
      report("submitted", { input_images: run.input_images.map(({ id, sha256 }) => ({ id, sha256 })) });
      await waitFor("submit permit", () => messages.some((message) => message.type === "bridge:permit" && message.id === run.id));
      report("prompt-sent");
      return report;
    } };
}

async function sample(host, ext) {
  const file = path.join(host.dir, "fixture." + ext);
  await exec("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=blue:s=96x96:r=10",
    ...(ext === "png" ? ["-frames:v", "1", "-update", "1"] : ["-frames:v", "3", "-c:v", "libx264"]),
    "-threads", "1", file]);
  return fs.readFile(file);
}

async function runWorker(t, host, pairCode, item) {
  const state = {};
  const events = [];
  const noop = { addListener() {} };
  const worker = vm.createContext({
    URL, AbortSignal, crypto: webcrypto, setTimeout, clearTimeout, setInterval, clearInterval,
    WebSocket: class extends WebSocket {
      constructor(url, protocols) { super(url, protocols, { ca: host.ca, origin }); }
    },
    fetch: (url, options) => {
      assert.equal(url, host.base + "/api/extension/pair");
      return host.http("/api/extension/pair", "POST", JSON.parse(options.body), { Origin: origin })
        .then((response) => ({ ok: response.status === 201, json: response.json }));
    },
    chrome: {
      runtime: { onInstalled: noop, onStartup: noop, onMessage: noop,
        getManifest: () => ({ version: "0.7.0", homepage_url: host.base }) },
      storage: {
        onChanged: { addListener(listener) { events.push(listener); } },
        local: {
          setAccessLevel: async ({ accessLevel }) => assert.equal(accessLevel, "TRUSTED_CONTEXTS"),
          get: async (value) => typeof value === "string" ? { [value]: state[value] } : { ...value, ...state },
          set: async (values) => {
            const changes = Object.fromEntries(Object.entries(values).map(([key, newValue]) => [key, { newValue }]));
            Object.assign(state, values);
            for (const callback of events) callback(changes, "local");
          },
        },
      },
      action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
      tabs: { onUpdated: noop, onRemoved: noop, onActivated: noop, query: async () => [{ id: item.tabId, url: item.url, status: "complete" }],
        sendMessage: async () => item },
      webNavigation: { onCommitted: noop, onHistoryStateUpdated: noop, getFrame: async () => ({ documentId: item.documentToken, url: item.url }) },
    },
  });
  vm.runInContext(await fs.readFile("extension/background.js", "utf8"), worker);
  t.after(() => vm.runInContext("pauseBridge()", worker));
  await vm.runInContext(`pairCloud(${JSON.stringify(host.base)}, ${JSON.stringify(pairCode)})`, worker);
  const result = await vm.runInContext("getState()", worker);
  assert.equal(result.settings.token, "");
  return { id: state.profileInstanceId, disconnect: () => vm.runInContext("pauseBridge()", worker) };
}

test("cloud gateway uses HTTPS/WSS, scopes, fenced tabs, durable media and trace metrics", { timeout: 45_000 }, async (t) => {
  const host = await fixtures(t);
  const browserEnabled = process.env.BRIDGE_TEST_DASHBOARD === "1";
  assert.equal((await host.http("/")).status, 200);
  assert.equal((await host.http("/admin/dashboard")).status, 401);
  assert.equal((await host.http("/openapi.json")).json().openapi, "3.1.0");
  assert.equal((await fetch("http://127.0.0.1:" + host.upstream + "/v1/models")).status, 421);
  const admin = await login(host);
  const key = (await admin("keys", "POST", { name: "MacFlow", scopes: ["read", "generate", "upload", "download"] })).json().key;
  const restricted = (await admin("keys", "POST", { name: "Read only", scopes: ["read"] })).json();
  const auth = (route, method, data, headers) => host.http(route, method, data, { Authorization: "Bearer " + key, ...headers });
  assert.equal((await host.http("/v1/models")).status, 401);
  assert.equal((await host.http("/v1/chat/completions", "POST", {}, { Authorization: "Bearer " + restricted.key })).status, 403);
  assert.equal((await auth("/v1/models", "GET", null, { Origin: "https://unauthorized.example" })).status, 403);
  assert.equal((await admin("origins", "POST", { origins: ["https://macflow.example"] })).status, 200);
  assert.equal((await auth("/v1/models", "OPTIONS", null, { Origin: "https://macflow.example" })).headers["access-control-allow-origin"], "https://macflow.example");

  const code = (await admin("pairings", "POST", { name: "Studio Chrome" })).json().code;
  const profileInstanceId = randomUUID();
  const pairing = await host.http("/api/extension/pair", "POST", { profileInstanceId, code }, { Origin: origin });
  assert.equal(pairing.status, 201, pairing.content.toString());
  const credential = pairing.json().credential;
  assert.equal((await host.http("/api/extension/pair", "POST", { profileInstanceId, code }, { Origin: origin })).status, 401);
  const archive = await admin("extension.zip");
  assert.equal(archive.status, 200);
  const archiveFile = path.join(host.dir, "extension.zip");
  await fs.writeFile(archiveFile, archive.content);
  const manifest = JSON.parse((await exec("unzip", ["-p", archiveFile, "extension/manifest.json"])).stdout);
  assert.ok(manifest.host_permissions.includes("https://muse.ai/*"));
  assert.ok(manifest.content_scripts[0].js.includes("muse-adapter.js"));
  await exec("unzip", ["-p", archiveFile, "extension/muse-adapter.js"]);
  assert.equal(manifest.homepage_url, host.base);
  assert.ok(manifest.host_permissions.includes(host.base + "/*"));

  const tab = { tabId: 42, documentToken: randomUUID(), provider: "chatgpt", title: "Studio",
    url: "https://chatgpt.com/c/fixture", ready: true, busy: false, outputKinds: ["text", "image", "video"], input_image_support: true };
  const target = { tabId: tab.tabId, documentToken: tab.documentToken, url: tab.url, profileInstanceId };
  const extension = await connect(t, host, profileInstanceId, credential, tab);
  await waitFor("tab inventory", async () => (await auth("/api/bridge/status")).json().tabs.length === 1);
  assert.deepEqual((await auth("/api/bridge/status")).json().tabs[0].outputKinds, []);
  const actualWorkerCode = (await admin("pairings", "POST", { name: "Worker fixture" })).json().code;
  const worker = await runWorker(t, host, actualWorkerCode, { ...tab, tabId: 92, outputKinds: ["text"] });
  await waitFor("worker WSS inventory", async () => (await auth("/api/bridge/status")).json().tabs.some((entry) => entry.profileInstanceId === worker.id));
  const limited = { id: "limited-video", provider: "chatgpt", kinds: ["video"], enabled: true,
    target: { ...target, profileInstanceId: worker.id, tabId: 92 } };
  assert.equal((await admin("models", "POST", limited)).status, 200);
  const limitedList = (await auth("/v1/models")).json().data;
  assert.deepEqual(limitedList.find((entry) => entry.id === limited.id).capabilities.outputKinds, []);
  assert.equal((await auth("/v1/videos", "POST", { model: limited.id, client_request_id: "unsupported", prompt: "Fixture" })).json().error.code, "TAB_UNSUPPORTED");
  worker.disconnect();
  const model = { id: "studio-image", provider: "chatgpt", kinds: ["text", "image", "video"], inputImages: true, enabled: true, target };
  assert.equal((await admin("models", "POST", model)).status, 200);
  await waitFor("config delivery", () => extension.messages.some((message) => message.type === "bridge:config" && message.models.length === 1));
  const models = (await auth("/v1/models")).json().data;
  assert.deepEqual(models.find((entry) => entry.id === model.id).capabilities.outputKinds, ["text", "image", "video"]);
  const published = (await auth("/api/bridge/status")).json().tabs.find((tab) => tab.profileInstanceId === profileInstanceId);
  assert.deepEqual(published.model_ids, { text: [model.id], image: [model.id], video: [model.id] });

  if (browserEnabled) {
    const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN ?? "/usr/bin/chromium", headless: true, args: ["--no-sandbox"] });
    t.after(() => browser.close());
    const page = await browser.newPage({ ignoreHTTPSErrors: true });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(host.base);
    await page.getByLabel("Mật khẩu").fill(adminPass);
    await page.getByRole("button", { name: "Đăng nhập" }).click();
    await page.locator("#metrics .metric").first().waitFor();
    await page.getByRole("button", { name: "AI và model" }).click();
    await page.getByText("studio-image", { exact: true }).waitFor();
    await page.getByRole("row", { name: /studio-image/ }).getByRole("button", { name: "Chỉnh sửa" }).click();
    assert.equal(await page.locator("#model-form input[name=id]").inputValue(), "studio-image");
    await page.getByRole("button", { name: "Tạo model mới" }).click();
    await page.getByLabel("Model ID dùng trong API").fill("studio-disabled");
    await page.locator("#model-form select[name=provider]").selectOption("chatgpt");
    await page.getByLabel("Bật model").uncheck();
    await page.getByRole("button", { name: "Lưu model" }).click();
    await page.getByText("studio-disabled", { exact: true }).waitFor();
    assert.ok((await auth("/v1/models")).json().data.every((entry) => entry.id !== "studio-disabled"));
    await page.getByRole("button", { name: "Chrome và tiện ích" }).click();
    await page.getByText("Studio Chrome", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Cập nhật", exact: true }).click();
    const updateLink = page.getByRole("link", { name: "Mở bảng cập nhật" });
    await updateLink.waitFor();
    assert.equal(await updateLink.getAttribute("href"), "https://updater.example.test");
    assert.deepEqual(errors, []);
    await browser.close();
  }

  const image = await sample(host, "png");
  const video = await sample(host, "mp4");
  const uploaded = await auth("/v1/input-images", "POST", image, { "Content-Type": "image/png" });
  assert.equal(uploaded.status, 201, uploaded.content.toString());
  assert.equal(uploaded.json().sha256, sha(image));
  const imageRequest = { model: model.id, prompt: "Fixture image", input_images: [uploaded.json().id], response_format: "b64_json", client_request_id: "image-1" };
  const pending = auth("/v1/images/generations", "POST", imageRequest);
  const run = await extension.run();
  assert.deepEqual(run.target, target);
  assert.equal(run.input_images[0].sha256, sha(image));
  const imageReport = await extension.submit(run);
  imageReport("website-completed");
  imageReport("media-chunk", { index: 0, offset: 0, data: image.toString("base64") });
  imageReport("complete", { media: [{ kind: "image", mime_type: "image/png", size: image.length, sha256: sha(image) }] });
  const generated = await pending;
  assert.equal(generated.status, 200, generated.content.toString());
  assert.deepEqual(Buffer.from(generated.json().data[0].b64_json, "base64"), image);
  const imageId = generated.json().media[0].id;
  assert.equal(generated.headers["x-task-id"], run.id);
  assert.deepEqual((await auth("/v1/images/generations", "POST", imageRequest)).json(), generated.json());
  assert.equal(extension.messages.filter((message) => message.type === "bridge:run").length, 1);
  const download = await auth("/v1/media/" + imageId);
  assert.equal(download.headers["content-type"], "image/png");
  assert.equal(download.headers["cache-control"], "private, no-store");
  assert.deepEqual(download.content, image);
  assert.equal((await host.http("/v1/media/" + imageId)).status, 401);
  assert.equal((await host.http("/v1/media/" + imageId, "GET", null, { Authorization: "Bearer " + restricted.key })).status, 403);

  const videoRequest = { model: model.id, prompt: "Fixture video", client_request_id: "video-1" };
  const videoTask = await auth("/v1/videos", "POST", videoRequest);
  assert.equal(videoTask.status, 202, videoTask.content.toString());
  const taskId = videoTask.json().task_id;
  const nextRun = await extension.run(1);
  assert.equal(nextRun.id, taskId);
  const videoReport = await extension.submit(nextRun);
  assert.equal((await auth("/v1/videos", "POST", { ...videoRequest, client_request_id: "other" })).json().error.code, "TAB_BUSY");
  videoReport("website-completed");
  videoReport("media-chunk", { index: 0, offset: 0, data: video.toString("base64") });
  videoReport("complete", { media: [{ kind: "video", mime_type: "video/mp4", size: video.length, sha256: sha(video) }] });
  const complete = await waitFor("video completion", async () => {
    const result = (await auth("/v1/videos/" + taskId)).json();
    return result.status === "completed" ? result : null;
  });
  assert.deepEqual((await auth("/v1/media/" + complete.media[0].id)).content, video);

  const uncertain = { ...videoRequest, client_request_id: "video-disconnect" };
  const unknown = (await auth("/v1/videos", "POST", uncertain)).json();
  await extension.submit(await extension.run(2));
  extension.peer.terminate();
  await waitFor("unknown", async () => (await auth("/v1/videos/" + unknown.task_id)).json().status === "unknown");
  await host.stop();
  if (host.database) await fs.rm(host.root, { recursive: true, force: true });
  await host.start();
  const resumed = await connect(t, host, profileInstanceId, credential, tab);
  await waitFor("tab reconnect", async () => (await auth("/api/bridge/status")).json().tabs[0]?.busy);
  assert.equal((await auth("/v1/videos", "POST", uncertain)).json().task_id, unknown.task_id);
  assert.equal((await auth("/v1/videos/" + unknown.task_id)).json().status, "unknown");
  assert.equal(resumed.messages.filter((message) => message.type === "bridge:run").length, 0);
  assert.deepEqual((await auth("/v1/media/" + complete.media[0].id)).content, video);
  assert.ok(host.objects.has("/fixture/ai-br/output/" + complete.media[0].id));
  assert.ok(host.signatures.every(Boolean));

  const timeline = (await admin("tasks/" + taskId)).json();
  assert.equal(timeline.task.trace_id, videoTask.headers["x-trace-id"]);
  const stages = timeline.events.map((entry) => entry.stage);
  for (const stage of ["api_received", "auth_ok", "queued", "dispatched", "extension_received", "prompt_sent", "website_completed",
    "media_uploaded", "media_saved", "completed", "returned", "downloaded"]) assert.ok(stages.includes(stage), stage);
  const dashboard = (await admin("dashboard")).json();
  assert.equal(dashboard.stats.completed, 2);
  assert.equal(dashboard.stats.dispatched, 3);
  assert.equal(dashboard.stats.extension_received, 3);
  assert.equal(dashboard.stats.returned, 2);
  assert.equal(dashboard.stats.unknown, 1);
  assert.ok(dashboard.stats.errors >= 3);
  assert.ok(dashboard.events.some((item) => item.code === "TAB_BUSY" && item.layer === "routing"));
  const auditFile = path.join(host.root, "events.jsonl");
  if (host.database) await assert.rejects(fs.stat(auditFile), { code: "ENOENT" });
  const audit = host.database ? "" : await fs.readFile(auditFile, "utf8");
  for (const value of [key, restricted.key, code, credential, adminPass, "Fixture image", "fixture-storage-secret"]) {
    assert.ok(!(audit + host.output() + JSON.stringify(dashboard) + JSON.stringify(timeline)).includes(value));
  }
  assert.equal((await admin("keys/" + restricted.id, "DELETE")).status, 200);
  assert.equal((await host.http("/v1/models", "GET", null, { Authorization: "Bearer " + restricted.key })).status, 401);

  const refreshed = { ...tab, documentToken: randomUUID() };
  resumed.send({ type: "bridge:status", tabs: [refreshed] });
  await waitFor("updated document", async () => (await auth("/api/bridge/status")).json().tabs[0]?.documentToken === refreshed.documentToken);
  assert.equal((await admin("models", "POST", { ...model, target: { ...target, documentToken: refreshed.documentToken } })).status, 200);
  const text = auth("/v1/chat/completions", "POST", {
    model: model.id, client_request_id: "text-stream", stream: true, input_images: [uploaded.json().id],
    messages: [{ role: "user", content: "Fixture text" }],
  });
  const resumedRun = await resumed.run();
  assert.deepEqual(Buffer.from(resumedRun.input_images[0].data, "base64"), image);
  const textReport = await resumed.submit(resumedRun);
  textReport("website-completed");
  textReport("complete", { media: [], text: "Fixture streamed response" });
  const textResult = await text;
  assert.equal(textResult.status, 200);
  assert.match(textResult.headers["content-type"], /^text\/event-stream/);
  assert.match(textResult.content.toString(), /Fixture streamed response/);
  assert.match(textResult.content.toString(), /data: \[DONE\]/);

  const museTab = { ...refreshed, tabId: 101, provider: "muse", url: "https://muse.ai/thread/fixture" };
  const museTarget = { profileInstanceId, tabId: museTab.tabId, documentToken: museTab.documentToken, url: museTab.url };
  resumed.send({ type: "bridge:status", tabs: [refreshed, museTab] });
  await waitFor("Muse inventory", async () => (await admin("dashboard")).json().inventory.tabs.some((entry) => entry.provider === "muse"));
  assert.equal((await admin("models", "POST", { ...model, id: "bridge-muse", provider: "muse", target: museTarget })).status, 200);
  const museModel = (await auth("/v1/models")).json().data.find((entry) => entry.id === "bridge-muse");
  assert.deepEqual(museModel.capabilities, { outputKinds: ["text", "image", "video"], input_image_support: true });
  const museRequest = { model: "bridge-muse", client_request_id: "muse-video", prompt: "Fixture Muse video" };
  const museTask = await auth("/v1/videos", "POST", museRequest);
  assert.equal(museTask.status, 202, museTask.content.toString());
  const museRun = await resumed.run(1);
  assert.equal(museRun.provider, "muse");
  assert.equal(museRun.media_kind, "video");
  assert.deepEqual(museRun.target, museTarget);
  const museReport = await resumed.submit(museRun);
  museReport("website-completed");
  museReport("media-chunk", { index: 0, offset: 0, data: video.toString("base64") });
  museReport("complete", { media: [{ kind: "video", mime_type: "video/mp4", size: video.length, sha256: sha(video) }] });
  const museCompleted = await waitFor("Muse video completion", async () => {
    const task = (await auth("/v1/videos/" + museTask.json().task_id)).json();
    return task.status === "completed" ? task : null;
  });
  assert.deepEqual((await auth("/v1/media/" + museCompleted.media[0].id)).content, video);

  if (host.database) {
    const disconnected = once(resumed.peer, "close");
    const replacement = await openSharedState(host.database, namespaceFor(host.stateEnv, "gateway"));
    t.after(() => replacement.close());
    assert.equal((await auth("/v1/models")).status, 503);
    const health = await host.http("/health");
    assert.equal(health.status, 200);
    assert.deepEqual(health.json(), { ok: true, draining: true });
    await disconnected;
  }
});
