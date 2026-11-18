import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID, webcrypto } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);
const token = "browser-fixture-token";
const apiKey = "browser-fixture-key";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const browserFlags = process.env.CHROME_NO_SANDBOX === "1" ? ["--no-sandbox"] : [];

async function waitFor(label, callback, limit = 5000) {
  const deadline = Date.now() + limit;
  while (Date.now() < deadline) {
    const result = await callback();
    if (result) return result;
    await delay(50);
  }
  assert.fail(`Timed out waiting for ${label}`);
}

function launch(context, executable, args, environment = process.env) {
  const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"], env: environment });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const exited = once(child, "exit");
  const failed = new Promise((_, reject) => {
    child.once("error", reject);
    exited.then(([code, signal]) => reject(new Error(`${executable} exited (${code ?? signal}): ${output}`)), reject);
  });
  failed.catch(() => {});
  context.after(async () => {
    if (child.exitCode === null && child.signalCode === null && child.pid) {
      child.kill();
      await exited;
    }
  });
  return { output: () => output, failed };
}

async function openPort() {
  const probe = net.createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address();
  await promisify(probe.close.bind(probe))();
  return port;
}

async function devtools(url, context) {
  const socket = new WebSocket(url);
  await once(socket, "open");
  context.after(() => socket.close());
  const pending = new Map();
  const listeners = new Map();
  let id = 0;
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const callback = pending.get(message.id);
      pending.delete(message.id);
      callback?.(message);
    } else {
      listeners.get(message.method)?.(message.params, message.sessionId);
    }
  });
  const send = (method, params, sessionId) => new Promise((resolve, reject) => {
    const commandId = ++id;
    const timer = setTimeout(() => {
      pending.delete(commandId);
      reject(new Error(`DevTools did not answer ${method}`));
    }, 7000);
    pending.set(commandId, ({ result, error }) => {
      clearTimeout(timer);
      if (error) reject(new Error(`${method}: ${error.message}`));
      else resolve(result);
    });
    socket.send(JSON.stringify({ id: commandId, method, params, sessionId }));
  });
  const attach = async (targetId) => (await send("Target.attachToTarget", { targetId, flatten: true })).sessionId;
  const evaluate = async (sessionId, expression, contextId) => {
    const result = await send("Runtime.evaluate", { expression, contextId, awaitPromise: true, returnByValue: true }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  return { send, attach, evaluate, on: (name, handler) => listeners.set(name, handler) };
}

function event() {
  const listeners = [];
  return {
    addListener: (listener) => listeners.push(listener),
    emit: (...args) => listeners.forEach((listener) => listener(...args)),
    message: (...args) => new Promise((resolve) => {
      const asynchronous = listeners.map((listener) => listener(...args, resolve)).includes(true);
      if (!asynchronous) resolve(undefined);
    }),
  };
}

const CONTENT_WORLD = "AI Bridge test";
const CONTENT_RUNTIME = `
let receive;
const replies = new Map();
let requestId = 0;
globalThis.chrome = { runtime: {
  onMessage: { addListener: (listener) => { receive = listener; } },
  sendMessage: (message) => new Promise((resolve) => {
    const id = ++requestId;
    replies.set(id, resolve);
    __aiBridgeSend(JSON.stringify({ message, id }));
  }),
} };
globalThis.__aiBridgeReply = (id, response) => {
  replies.get(id)?.(response);
  replies.delete(id);
};
globalThis.__aiBridgeReceive = (message) => new Promise((resolve) => {
  const async = receive(message, {}, resolve);
  if (!async) resolve(undefined);
});
`;

async function chromeApiFixture(cdp, bridgePort, context) {
  const tabs = new Map();
  const sessions = new Map();
  const settings = { serverUrl: `http://127.0.0.1:${bridgePort}`, token };
  const runtime = {
    onInstalled: event(), onStartup: event(), onMessage: event(), getManifest: () => ({ version: "0.6.0" }),
  };
  const navigation = { onCommitted: event(), onHistoryStateUpdated: event() };
  const updated = event();
  let error;
  const worker = vm.createContext({
    crypto: webcrypto, WebSocket, URL, setTimeout, clearTimeout, setInterval, clearInterval,
    chrome: {
      runtime, action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
      storage: {
        onChanged: event(),
        local: {
          get: async (key) => typeof key === "string" ? { [key]: settings[key] } : { ...key, ...settings },
          set: async (values) => Object.assign(settings, values),
        },
      },
      tabs: {
        onUpdated: updated, onRemoved: event(), onActivated: event(),
        query: async () => [...tabs.values()].map(({ tab }) => ({ ...tab })),
        get: async (id) => ({ ...tabs.get(id).tab }),
        sendMessage: async (id, message, { documentId } = {}) => {
          const page = tabs.get(id);
          if (!page?.contextId || documentId && page.documentId !== documentId) throw new Error("Document unavailable");
          const expression = `globalThis.__aiBridgeReceive(${JSON.stringify(message)})`;
          return cdp.evaluate(page.session, expression, page.contextId);
        },
      },
      webNavigation: {
        ...navigation,
        getFrame: async ({ tabId }) => {
          const page = tabs.get(tabId);
          return { documentId: page.documentId, url: page.tab.url };
        },
      },
    },
  });
  vm.runInContext(await fs.readFile("extension/background.js", "utf8"), worker, { filename: "background.js" });
  context.after(() => vm.runInContext("pauseBridge()", worker));

  cdp.on("Page.frameNavigated", ({ frame }, session) => {
    const page = sessions.get(session);
    if (!page || frame.parentId) return;
    page.documentId = randomUUID();
    page.tab.url = frame.url;
    page.tab.title = new URL(frame.url).hostname;
    page.tab.status = "loading";
    navigation.onCommitted.emit({ frameId: 0, tabId: page.tab.id });
  });
  cdp.on("Page.loadEventFired", (_, session) => {
    const page = sessions.get(session);
    if (!page) return;
    page.tab.status = "complete";
    updated.emit(page.tab.id, { status: "complete" });
  });
  cdp.on("Runtime.executionContextCreated", ({ context: world }, session) => {
    const page = sessions.get(session);
    if (world.name === CONTENT_WORLD && page) page.contextId = world.id;
  });
  cdp.on("Runtime.executionContextsCleared", (_, session) => {
    const page = sessions.get(session);
    if (page) page.contextId = null;
  });
  cdp.on("Runtime.bindingCalled", ({ payload, executionContextId }, session) => {
    const page = sessions.get(session);
    const { message, id } = JSON.parse(payload);
    const sender = { frameId: 0, tab: { ...page.tab }, url: page.tab.url, documentId: page.documentId };
    runtime.onMessage.message(message, sender).then((reply) => cdp.evaluate(
      session, `globalThis.__aiBridgeReply(${id}, ${JSON.stringify(reply)})`, executionContextId,
    )).catch((failure) => {
      if (executionContextId === page.contextId) error = failure;
    });
  });

  const scripts = await Promise.all(["media-adapters.js", "content.js"].map((file) => fs.readFile(path.join("extension", file), "utf8")));
  return {
    check() { if (error) throw error; },
    async open(url) {
      const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
      const session = await cdp.attach(targetId);
      const tab = { id: tabs.size + 1, url: "about:blank", status: "loading" };
      const page = { session, tab };
      tabs.set(tab.id, page);
      sessions.set(session, page);
      await cdp.send("Runtime.enable", {}, session);
      await cdp.send("Page.enable", {}, session);
      await cdp.send("Runtime.addBinding", { name: "__aiBridgeSend", executionContextName: CONTENT_WORLD }, session);
      await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
        source: [CONTENT_RUNTIME, ...scripts].join("\n"),
        worldName: CONTENT_WORLD,
      }, session);
      await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "https://*" }] }, session);
      await cdp.send("Page.navigate", { url }, session);
      return session;
    },
  };
}

const CHAT_PAGE = `<!doctype html><meta charset="utf-8"><title>ChatGPT fixture</title>
<div id="messages"><article data-message-author-role="assistant" data-message-id="old">
  <img alt="Generated image" src="/backend-api/estuary/content?id=file-old">
</article></div>
<form><textarea id="prompt-textarea"></textarea><div id="attachments"></div>
<button type="button" data-testid="composer-tool-pill">Create image</button>
<input id="upload-files" type="file" multiple accept="image/*" hidden>
<button type="button" data-testid="composer-plus-btn">Attach</button>
<button data-testid="send-button" type="submit">Send</button></form>
<script>
window.clicks = 0;
window.attached = [];
const input = document.querySelector('#upload-files');
const attachments = document.querySelector('#attachments');
const messages = document.querySelector('#messages');
input.addEventListener('change', () => {
  if (location.pathname === '/c/no-attachment') return;
  attachments.setAttribute('aria-busy', 'true');
  setTimeout(() => {
    for (const file of input.files) {
      const name = document.createElement('div');
      name.dataset.testid = 'attachment-name';
      name.textContent = file.name;
      attachments.append(name);
    }
    attachments.removeAttribute('aria-busy');
  }, 250);
});
document.querySelector('form').addEventListener('submit', (event) => {
  event.preventDefault();
  window.clicks++;
  const user = document.createElement('article');
  user.dataset.messageAuthorRole = 'user';
  user.dataset.messageId = 'user-' + window.clicks;
  user.innerText = document.querySelector('textarea').value;
  window.attached = [...input.files].map((file) => ({ name: file.name, size: file.size }));
  document.querySelector('textarea').value = '';
  input.value = '';
  attachments.replaceChildren();
  messages.append(user);
  const stop = document.createElement('button');
  stop.setAttribute('aria-label', 'Stop');
  stop.textContent = 'Stop';
  messages.append(stop);
  setTimeout(() => {
    const answer = document.createElement('article');
    answer.dataset.messageAuthorRole = 'assistant';
    answer.dataset.messageId = 'assistant-' + window.clicks;
    const image = document.createElement('img');
    image.alt = 'Generated image';
    image.src = '/backend-api/estuary/content?id=file-new';
    answer.append(image);
    messages.append(answer);
    stop.remove();
  }, 500);
});
</script>`;

const VIDEO_URL = "https://assets.grok.com/users/fixture/generated/new/generated_video.mp4";
const GROK_PAGE = `<!doctype html><meta charset="utf-8"><title>Grok fixture</title>
<textarea></textarea><button type="button">Generate video</button>
<script>
window.clicks = 0;
document.querySelector('button').onclick = () => {
  window.clicks++;
  document.querySelector('textarea').value = '';
  const stop = document.createElement('button');
  stop.setAttribute('aria-label', 'Stop');
  stop.textContent = 'Stop';
  document.body.append(stop);
  setTimeout(() => {
    const video = document.createElement('video');
    video.controls = true;
    video.src = ${JSON.stringify(VIDEO_URL)};
    document.body.append(video);
    stop.remove();
  }, 1100);
};
</script>`;

test("the extension code pins a Chromium fixture tab, verifies attachments and returns image/video artifacts", { timeout: 65_000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ai-bridge-chrome-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const make = async (name, color, options) => {
    const file = path.join(directory, name);
    await exec("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", `color=${color}:s=320x320:r=10`,
      ...options, "-threads", "1", file]);
    return fs.readFile(file);
  };
  const [image, oldImage, video] = await Promise.all([
    make("image.png", "green", ["-frames:v", "1", "-update", "1"]),
    make("old.png", "red", ["-frames:v", "1", "-update", "1"]),
    make("video.mp4", "blue", ["-frames:v", "5", "-c:v", "libx264", "-movflags", "+faststart"]),
  ]);
  const port = await openPort();
  const server = launch(t, process.execPath, ["local-server.mjs", `--port=${port}`, `--token=${token}`], {
    ...process.env, BRIDGE_API_KEY: apiKey, BRIDGE_DATA_DIR: path.join(directory, "data"),
  });
  await Promise.race([server.failed, waitFor("server", () => server.output().includes("AI Bridge listening"))]);
  const chrome = launch(t, process.env.CHROME_BIN ?? "chromium", [
    "--headless=new", ...browserFlags, "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check",
    "--no-proxy-server", "--disable-background-networking", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
    `--user-data-dir=${path.join(directory, "chrome")}`, "--remote-debugging-port=0", "about:blank",
  ]);
  const endpoint = await Promise.race([chrome.failed, waitFor("DevTools endpoint", () => (
    chrome.output().match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1]
  ))]);
  const cdp = await devtools(endpoint, t);
  const fixture = await chromeApiFixture(cdp, port, t);

  let routingError;
  cdp.on("Fetch.requestPaused", ({ requestId, request }, sessionId) => {
    const url = new URL(request.url);
    let bytes;
    let mime;
    const headers = [{ name: "Cache-Control", value: "no-store" }];
    if (url.hostname === "chatgpt.com" && url.pathname === "/backend-api/estuary/content") {
      bytes = url.searchParams.get("id") === "file-new" ? image : oldImage;
      mime = "image/png";
    } else if (request.url === VIDEO_URL) {
      bytes = video;
      mime = "video/mp4";
      headers.push({ name: "Access-Control-Allow-Origin", value: "https://grok.com" });
    } else {
      bytes = Buffer.from(url.hostname === "chatgpt.com" ? CHAT_PAGE : GROK_PAGE);
      mime = "text/html";
    }
    headers.push({ name: "Content-Type", value: mime }, { name: "Content-Length", value: String(bytes.length) });
    cdp.send("Fetch.fulfillRequest", { requestId, responseCode: 200, responseHeaders: headers, body: bytes.toString("base64") }, sessionId)
      .catch((error) => { routingError = error; });
  });

  const post = (route, body, headers) => request(route, { method: "POST", body, headers });
  function request(route, options = {}) {
    return fetch(`http://127.0.0.1:${port}${route}`, {
      ...options, headers: { Authorization: `Bearer ${apiKey}`, ...options.headers },
    });
  }
  const status = async () => {
    fixture.check();
    if (routingError) throw routingError;
    return (await request("/api/bridge/status")).json();
  };
  const selectedUrl = "https://chatgpt.com/c/selected";
  const otherUrl = "https://chatgpt.com/c/other";
  const grokUrl = "https://grok.com/imagine";
  const selected = await fixture.open(selectedUrl);
  const other = await fixture.open(otherUrl);
  const grok = await fixture.open(grokUrl);
  const findTab = (url, kind) => waitFor(`ready ${url}`, async () => (await status()).tabs.find((tab) => (
    tab.url === url && tab.ready && tab.outputKinds.includes(kind)
  )), 8000);
  const chat = await findTab(selectedUrl, "image");
  const sameProvider = await findTab(otherUrl, "image");
  const grokTab = await findTab(grokUrl, "video");
  assert.equal(chat.profileInstanceId, sameProvider.profileInstanceId);
  assert.notEqual(chat.tabId, sameProvider.tabId);
  assert.notEqual(chat.documentToken, sameProvider.documentToken);
  assert.equal(chat.input_image_support, true);
  assert.equal(grokTab.input_image_support, false);

  const upload = await post("/v1/input-images", oldImage, { "content-type": "image/png" });
  assert.equal(upload.status, 201);
  const { id } = await upload.json();
  const completion = (tab, media_kind, input_images = []) => post("/v1/chat/completions", JSON.stringify({
    model: `bridge-${tab.provider}`, target: tab, media_kind, stream: false, input_images,
    messages: [{ role: "user", content: "Generate a new media file for this test." }],
  }), { "content-type": "application/json" });
  const checkFile = async (response, bytes, kind) => {
    assert.equal(response.status, 200, await response.clone().text());
    const [media] = (await response.json()).media;
    assert.equal(media.sha256, hash(bytes));
    assert.equal(media.kind, kind);
    assert.deepEqual(Buffer.from(await (await request(`/v1/media/${media.id}`)).arrayBuffer()), bytes);
  };
  await checkFile(await completion(chat, "image", [id]), image, "image");
  assert.equal(await cdp.evaluate(selected, "window.clicks"), 1);
  assert.equal(await cdp.evaluate(other, "window.clicks"), 0);
  const [attached] = await cdp.evaluate(selected, "window.attached");
  assert.match(attached.name, /^bridge-1-[\da-f]{8}\.png$/);
  assert.equal(attached.size, oldImage.length);

  await checkFile(await completion(grokTab, "video"), video, "video");
  assert.equal(await cdp.evaluate(grok, "window.clicks"), 1);

  await cdp.send("Page.reload", { ignoreCache: true }, selected);
  await waitFor("new document after reload", async () => (await status()).tabs.some((tab) => (
    tab.url === selectedUrl && tab.documentToken !== chat.documentToken && tab.ready
  )));
  const old = await completion(chat, "image");
  assert.equal(old.status, 409);
  assert.equal((await old.json()).error.code, "TAB_STALE");
  assert.equal(await cdp.evaluate(selected, "window.clicks"), 0);

  const noAttachmentUrl = "https://chatgpt.com/c/no-attachment";
  const noAttachment = await fixture.open(noAttachmentUrl);
  const noAttachmentTab = await findTab(noAttachmentUrl, "image");
  const refused = await completion(noAttachmentTab, "image", [id]);
  assert.equal(refused.status, 422);
  assert.equal((await refused.json()).error.code, "INPUT_IMAGE_INVALID");
  assert.equal(await cdp.evaluate(noAttachment, "window.clicks"), 0);
});
