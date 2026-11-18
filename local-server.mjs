import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { URL } from "node:url";
import {
  DEFAULT_PROMPT_INSTRUCTION_SETTINGS,
  PROVIDER_DISPLAY_NAMES,
  buildPromptWithInstructions,
  ensurePromptInstructionsLayout,
} from "./prompt-instructions.mjs";
import { makeAssistantMessage } from "./tool-calls.mjs";
import { createMediaBridge } from "./media-bridge.mjs";
import { BridgeError, createMediaStore, defaultMediaRetentionHours } from "./media-store.mjs";
import { createCloudControl, errorLayer } from "./cloud-control.mjs";

const MAX_BODY_BYTES = 1_000_000;
const MAX_QUEUE_LENGTH = 10;
const REQUEST_TIMEOUT_MS = 240_000;
const PROVIDERS = ["auto", "grok", "gemini", "deepseek", "perplexity", "qwen", "chatgpt", "claude", "zai", "kimi"];
if (PROVIDERS.slice(1).some((provider) => !PROVIDER_DISPLAY_NAMES[provider])) {
  throw new Error("PROVIDER_DISPLAY_NAMES is missing a provider from PROVIDERS.");
}
const DEFAULT_BRIDGE_SETTINGS = Object.freeze({
  interceptTitleRequests: true,
  ...DEFAULT_PROMPT_INSTRUCTION_SETTINGS,
});

const args = parseArgs(process.argv.slice(2));
const cloudMode = process.env.BRIDGE_MODE === "cloud";
const configuredPort = args.port ?? (cloudMode ? process.env.PORT : process.env.BRIDGE_PORT);
const port = readPort(configuredPort ?? (cloudMode ? "10000" : "4319"));
const tokenConfig = cloudMode ? {} : resolveBridgeToken(args);
const settingsConfig = loadBridgeSettings(args);
const promptInstructionsDir = resolvePromptInstructionsDirectory(args, settingsConfig.path);
const bridgeToken = tokenConfig.token;
const apiKey = args.apiKey ?? process.env.BRIDGE_API_KEY ?? "";
const interceptTitleRequests = process.env.BRIDGE_INTERCEPT_TITLES === undefined
  ? settingsConfig.settings.interceptTitleRequests
  : process.env.BRIDGE_INTERCEPT_TITLES !== "0";
const injectPromptInstructionsEveryMessage = settingsConfig.settings.injectPromptInstructionsEveryMessage;
const prePromptName = settingsConfig.settings.prePrompt;
const postPromptName = settingsConfig.settings.postPrompt;
const disguiseModelNameAsAssistant = settingsConfig.settings.disguiseModelNameAsAssistant;

const clients = new Set();
const jobs = new Map();
const queue = [];
let activeJob = null;
const providerHosts = new Map([
  ["grok.com", "grok"], ["gemini.google.com", "gemini"], ["chat.deepseek.com", "deepseek"],
  ["www.perplexity.ai", "perplexity"], ["chat.qwen.ai", "qwen"], ["chat.qwenlm.ai", "qwen"],
  ["chatgpt.com", "chatgpt"], ["claude.ai", "claude"], ["chat.z.ai", "zai"], ["www.kimi.com", "kimi"],
]);
let mediaBridge;
let cloud;
let cloudObjects;
try {
  if (cloudMode) {
    const { createCloudObjects } = await import("./cloud-objects.mjs");
    cloudObjects = createCloudObjects(process.env);
  }
} catch {
  console.error("[ai-bridge] Cloud mode requires a private HTTPS object store configuration.");
  process.exit(1);
}

function configuredInteger(value, fallback, min, max) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new Error("Invalid numeric configuration.");
  return parsed;
}

function initializeMediaBridge() {
  if (cloudMode && !process.env.BRIDGE_DATA_DIR) throw new Error("Configure a persistent data directory.");
  const root = path.resolve(process.env.BRIDGE_DATA_DIR ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".ai-bridge-data"));
  const store = createMediaStore(root, cloudMode ? {
    objects: cloudObjects,
    quota: configuredInteger(process.env.BRIDGE_MEDIA_QUOTA_BYTES, 2 * 1024 ** 3, 16 * 1024 ** 2, 100 * 1024 ** 3),
    ttlMs: configuredInteger(process.env.BRIDGE_MEDIA_RETENTION_HOURS, defaultMediaRetentionHours, 1, 720) * 3_600_000,
  } : {});
  if (cloudMode) {
    store.requireValidator();
    cloud = createCloudControl({
      root, publicUrl: process.env.BRIDGE_PUBLIC_URL, updateUrl: process.env.BRIDGE_UPDATE_URL,
      adminPassword: process.env.BRIDGE_ADMIN_PASSWORD,
      providerLabels: PROVIDER_DISPLAY_NAMES, sendJson, profileClients: clients, status: () => mediaBridge.snapshot(),
      tasks: () => mediaBridge.listTasks(), mediaUsage: store.usage,
    });
  }
  return createMediaBridge({
    store, cloud,
    clients,
    providerLabels: PROVIDER_DISPLAY_NAMES,
    providerForModel,
    providerForUrl: (url) => providerHosts.get(new URL(url).host),
    createPrompt,
    complete: sendCompletion,
    sendJson,
    sendError: sendOpenAiError,
    legacyBusy: () => Boolean(activeJob),
    legacyQueueLength: () => queue.length,
    dispatch: dispatchNext,
  });
}

async function handleHttp(request, response) {
  try {
    if (!cloudMode && !isLoopback(request.socket.remoteAddress)) {
      return sendOpenAiError(response, 403, "AI Bridge only accepts loopback connections.", "forbidden");
    }

    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (cloudMode) {
      if (request.method === "GET" && url.pathname === "/health") return sendJson(response, 200, { ok: true });
      return await handleCloudHttp(request, response, url);
    }
    setCorsHeaders(response);
    if (request.method === "OPTIONS") return response.writeHead(204).end();
    if (request.method === "GET" && url.pathname === "/health") {
      return sendJson(response, 200, {
        ok: true,
        connected_extensions: clients.size,
        active_request: mediaBridge.activeId ?? activeJob?.id ?? null,
        queued_requests: queue.length + mediaBridge.queued,
      });
    }

    if (request.method === "GET" && url.pathname === "/v1/models") {
      requireApiKey(request);
      return sendJson(response, 200, {
        object: "list",
        data: PROVIDERS.map((provider) => ({
          id: `bridge-${provider}`,
          object: "model",
          created: 0,
          owned_by: "ai-bridge",
        })),
      });
    }

    if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
      if (apiKey) requireApiKey(request);
      const payload = await readJsonBody(request);
      if (payload && (Object.hasOwn(payload, "target") || Object.hasOwn(payload, "input_images") || Object.hasOwn(payload, "media_kind"))) {
        requireApiKey(request);
        return mediaBridge.prepare(payload, response);
      }
      return handleChatCompletion(response, payload);
    }

    if (url.pathname === "/api/bridge/status" || url.pathname === "/v1/input-images" || url.pathname.startsWith("/v1/media/")) {
      requireApiKey(request);
      return await mediaBridge.route(request, response, url.pathname, readJsonBody, activeJob?.id);
    }
    return sendOpenAiError(response, 404, "Route not found.", "not_found");
  } catch (error) {
    const failure = error instanceof BridgeError ? error : new BridgeError(500, "INTERNAL_ERROR", "The bridge could not process the request.");
    if (!response.headersSent) sendOpenAiError(response, failure.status, failure.message, failure.code);
    else response.end();
  }
}

function publicCloudStatus() {
  const inventory = mediaBridge.snapshot();
  const models = cloud.appModels();
  const tabs = inventory.tabs.map((tab) => {
    const matching = models.filter((item) => item.provider === tab.provider && (!item.target
      || ["profileInstanceId", "tabId", "documentToken", "url"].every((key) => item.target[key] === tab[key])));
    const model_ids = Object.fromEntries(tab.outputKinds.map((kind) => [kind,
      matching.filter((model) => model.capabilities.outputKinds.includes(kind)).map((model) => model.id),
    ]));
    return { ...tab,
      outputKinds: tab.outputKinds.filter((kind) => model_ids[kind].length),
      model_ids,
      input_image_support: tab.input_image_support && matching.some((model) => model.capabilities.input_image_support),
    };
  });
  return { ...inventory, tabs, input_image_support: tabs.some((tab) => tab.ready && tab.input_image_support) };
}

async function handleCloudHttp(request, response, url) {
  if (!cloud.allowed(request)) throw new BridgeError(421, "HOST_NOT_ALLOWED", "Use the configured HTTPS gateway.");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  const pathname = url.pathname;
  if (!pathname.startsWith("/v1/") && pathname !== "/api/bridge/status") return await cloud.route(request, response, url, readJsonBody);
  if (request.method === "OPTIONS") {
    cloud.cors(request, response);
    return response.writeHead(204).end();
  }

  const requestId = crypto.randomUUID();
  const traceId = crypto.randomUUID();
  response.bridgeRequestId = requestId;
  response.bridgeTraceId = traceId;
  response.bridgeIdempotency = request.headers["idempotency-key"];
  response.setHeader("X-Request-Id", requestId);
  response.setHeader("X-Trace-Id", traceId);
  const event = (stage, code) => cloud.event(stage, { request: requestId, trace: traceId, code });
  event("api_received");
  cloud.cors(request, response);
  let scope = "read";
  if (request.method === "DELETE") scope = "generate";
  if (request.method === "POST") scope = pathname === "/v1/input-images" ? "upload" : "generate";
  if (request.method === "GET" && /^\/v1\/media\/[^/]+$/.test(pathname) && pathname !== "/v1/media/tasks") scope = "download";
  try {
    response.bridgeOwner = cloud.authorize(request, scope);
    event("auth_ok");
  } catch (error) {
    event("auth_failed", error.code);
    throw error;
  }

  if (request.method === "GET" && pathname === "/v1/models") {
    const data = cloud.appModels().map(({ provider, target, ...model }) => model);
    return sendJson(response, 200, { object: "list", data });
  }
  if (request.method === "GET" && pathname === "/api/bridge/status") return sendJson(response, 200, publicCloudStatus());
  if (request.method === "POST" && pathname === "/v1/chat/completions") {
    response.bridgeFormat = "chat";
    return mediaBridge.prepare(await readJsonBody(request), response);
  }
  if (request.method === "POST" && ["/v1/images/generations", "/v1/videos"].includes(pathname)) {
    const payload = await readJsonBody(request);
    if (!payload || typeof payload.prompt !== "string" || !payload.prompt.trim()) throw new BridgeError(422, "INVALID_REQUEST", "A prompt is required.");
    const image = pathname === "/v1/images/generations";
    const supported = new Set(["model", "target", "prompt", "input_images", "client_request_id", ...(image ? ["n", "response_format"] : [])]);
    if (Object.keys(payload).some((key) => !supported.has(key)) || image && (payload.n !== undefined && payload.n !== 1
      || payload.response_format !== undefined && !["url", "b64_json"].includes(payload.response_format))) {
      throw new BridgeError(422, "UNSUPPORTED_PARAMETER", "This adapter does not support the requested option.");
    }
    if (image && payload.response_format === "b64_json") cloud.authorize(request, "download");
    response.bridgeFormat = image ? "images" : "tasks";
    response.bridgeImageEncoding = payload.response_format ?? "url";
    return mediaBridge.prepare({ ...payload, media_kind: image ? "image" : "video", stream: false,
      messages: [{ role: "user", content: payload.prompt }] }, response, !image);
  }
  if (request.method === "POST" && pathname === "/v1/media/tasks") response.bridgeFormat = "tasks";
  const route = pathname.startsWith("/v1/videos/") ? pathname.replace("/v1/videos/", "/v1/media/tasks/") : pathname;
  return await mediaBridge.route(request, response, route, readJsonBody);
}

function handleUpgrade(request, socket, head) {
  try {
    if (!cloudMode && !isLoopback(request.socket.remoteAddress)) return rejectUpgrade(socket, 403, "Loopback only");
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/bridge") return rejectUpgrade(socket, 404, "Not found");
    const profile = cloudMode ? cloud.socketProfile(request, url) : null;
    if (cloudMode ? !profile : url.searchParams.get("token") !== bridgeToken) return rejectUpgrade(socket, 401, "Invalid bridge credential");
    if (request.headers.upgrade?.toLowerCase() !== "websocket") return rejectUpgrade(socket, 400, "WebSocket required");

    const key = request.headers["sec-websocket-key"];
    if (typeof key !== "string") return rejectUpgrade(socket, 400, "Missing WebSocket key");
    const accept = crypto.createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      ...(cloudMode ? ["Sec-WebSocket-Protocol: ai-bridge"] : []),
      "",
      "",
    ].join("\r\n"));

    const client = createWebSocketClient(socket);
    client.pairedProfile = profile?.profile;
    clients.add(client);
    client.onClose = () => {
      clients.delete(client);
      log(`Chrome extension disconnected (${clients.size} active).`);
      cloud?.chromeEvent(client, "disconnected");
      mediaBridge.closed(client);
      failJobsForClient(client, "The Chrome extension disconnected while the request was running.");
    };
    client.onMessage = (message) => handleExtensionMessage(client, message);
    socket.setTimeout(65_000, () => socket.destroy());
    client.send({ type: "bridge:connected", providers: PROVIDERS.slice(1) });
    if (head.length) client.consume(head);
    log(`Chrome extension connected (${clients.size} active).`);
  } catch {
    socket.destroy();
  }
}

function listen(localPort, onReady) {
  const server = http.createServer(handleHttp).on("upgrade", handleUpgrade);
  server.on("error", () => {
    if (onReady) {
      log(`Unable to listen on port ${localPort}.`);
      process.exitCode = 1;
    } else {
      log(`Legacy listener unavailable on port ${localPort}.`);
    }
  });
  server.listen(localPort, cloudMode ? "0.0.0.0" : "127.0.0.1", () => {
    try {
      onReady?.();
    } catch {
      log("Unable to open bridge storage or cloud configuration.");
      process.exitCode = 1;
      server.close();
      return;
    }
    log(cloudMode ? `AI Bridge listening on port ${localPort}` : `AI Bridge listening at http://127.0.0.1:${localPort}`);
    if (onReady && tokenConfig.path) log(`Bridge token file: ${tokenConfig.path}`);
    if (onReady && !apiKey && !cloudMode) log("Set BRIDGE_API_KEY to enable authenticated models, status and media APIs.");
  });
}

listen(port, () => {
  mediaBridge = initializeMediaBridge();
  if (!configuredPort && !cloudMode) listen(4317);
});

function handleChatCompletion(response, payload) {
  if (!payload || !Array.isArray(payload.messages) || payload.messages.length === 0) {
    return sendOpenAiError(response, 400, "'messages' must be a non-empty array.", "invalid_request_error", "messages");
  }
  if (payload.stream !== undefined && typeof payload.stream !== "boolean") {
    return sendOpenAiError(response, 400, "'stream' must be a boolean.", "invalid_request_error", "stream");
  }
  if (interceptTitleRequests && isConversationTitleRequest(payload.messages)) {
    return sendConversationTitle(response, payload);
  }
  if (clients.size === 0) {
    return sendOpenAiError(response, 503, "No Chrome extension is connected. Start the local server, then configure and enable the extension.", "bridge_unavailable");
  }
  if (queue.length + mediaBridge.queued >= MAX_QUEUE_LENGTH) {
    return sendOpenAiError(response, 429, "AI Bridge queue is full. Try again shortly.", "rate_limit_error");
  }

  const provider = providerForModel(payload.model);
  const { prompt, tools } = createPrompt(payload, provider);
  const job = {
    id: `bridge-${crypto.randomUUID()}`,
    model: typeof payload.model === "string" && payload.model ? payload.model : "bridge-auto",
    provider,
    prompt,
    tools,
    hasTools: tools.length > 0,
    stream: payload.stream === true,
    streamedContent: false,
    response,
    text: "",
    timer: null,
    client: null,
    done: false,
  };
  jobs.set(job.id, job);
  queue.push(job);
  if (job.stream) startStreamingResponse(job);
  dispatchNext();
}

function createPrompt(payload, provider) {
  const tools = Array.isArray(payload.tools) ? payload.tools : [];
  const prompt = buildPromptWithInstructions(
    formatPrompt(payload.messages, tools),
    payload.messages,
    provider,
    {
      everyMessage: injectPromptInstructionsEveryMessage,
      prePromptName,
      postPromptName,
      rootDirectory: promptInstructionsDir,
      disguiseModelNameAsAssistant,
    },
  );
  return { prompt, tools };
}

function isConversationTitleRequest(messages) {
  const lastUserMessage = [...messages].reverse().find((message) => message?.role === "user");
  if (!lastUserMessage) return false;
  const text = contentToText(lastUserMessage.content).toLowerCase().replace(/\s+/g, " ");
  const asksForTitle = /\b(?:title|name|summari[sz]e|label)\b/.test(text);
  const namesConversation = /\b(?:conversation|chat|discussion|thread|messages)\b/.test(text);
  const requestVerb = /\b(?:generate|create|write|provide|return|suggest|give|make|name|summari[sz]e)\b/.test(text);
  const titleOnly = /\b(?:title only|only the title|just the title|no explanation)\b/.test(text);
  return asksForTitle && requestVerb && (namesConversation || titleOnly);
}

function sendConversationTitle(response, payload) {
  const model = typeof payload.model === "string" && payload.model ? payload.model : "bridge-auto";
  const title = makeConversationTitle(payload.messages);
  const id = `title-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  if (payload.stream) {
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    response.flushHeaders?.();
    const titleJob = { id, model };
    writeSse(response, makeStreamChunk(titleJob, { role: "assistant", content: "" }, null));
    writeSse(response, makeStreamChunk(titleJob, { content: title }, null));
    writeSse(response, makeStreamChunk(titleJob, {}, "stop"));
    writeSse(response, "[DONE]");
    response.end();
    return;
  }
  sendJson(response, 200, {
    id: `chatcmpl-${id}`,
    object: "chat.completion",
    created,
    model,
    choices: [{ index: 0, message: { role: "assistant", content: title }, finish_reason: "stop" }],
  });
}

function makeConversationTitle(messages) {
  const lastTitleRequest = [...messages].reverse().find((message) => message?.role === "user");
  const sourceMessage = [...messages].reverse().find((message) => message?.role === "user" && message !== lastTitleRequest && !isConversationTitleRequest([message]));
  const source = contentToText(sourceMessage?.content ?? "");
  const words = source
    .replace(/```[\s\S]*?```/g, " ")
    .match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu)
    ?.filter((word) => !TITLE_STOP_WORDS.has(word.toLowerCase()))
    .slice(0, 7) ?? [];
  if (words.length === 0) return "New conversation";
  const title = words.join(" ");
  return `${title[0].toUpperCase()}${title.slice(1)}`.slice(0, 72);
}

const TITLE_STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "can", "for", "from", "how", "i", "in", "is", "it", "my", "of", "on", "or", "please", "the", "this", "that", "to", "we", "with", "you", "your",
]);

function dispatchNext() {
  if (activeJob || mediaBridge.startNext() || queue.length === 0) return;
  const job = queue.shift();
  const client = selectClient(job.provider);
  if (!client) {
    finishJobWithError(job, "No suitable Chrome extension is connected.");
    dispatchNext();
    return;
  }

  activeJob = job;
  job.client = client;
  job.timer = setTimeout(() => finishJobWithError(job, "The web chat did not finish before the 4 minute bridge timeout."), REQUEST_TIMEOUT_MS);
  client.send({
    type: "bridge:run",
    id: job.id,
    provider: job.provider,
    prompt: job.prompt,
  });
}

function handleExtensionMessage(client, message) {
  if (!message || typeof message !== "object" || typeof message.type !== "string") return;
  if (message.type === "bridge:hello") {
    if (cloudMode && (client.mediaProtocol || message.profileInstanceId !== client.pairedProfile || message.mediaProtocol !== 1)) {
      return client.socket.destroy();
    }
    client.providers = Array.isArray(message.providers) ? message.providers.filter((name) => PROVIDERS.includes(name)) : [];
    client.extensionVersion = typeof message.version === "string" && /^\d+\.\d+\.\d+$/.test(message.version) ? message.version : "unknown";
    mediaBridge.hello(client, message);
    if (cloudMode && !client.profileInstanceId) return client.socket.destroy();
    cloud?.chromeEvent(client, "connected");
    cloud?.config(client);
    return;
  }
  if (cloudMode && !client.mediaProtocol) return client.socket.destroy();
  if (message.type === "bridge:status") {
    const previous = client.tabs;
    mediaBridge.updateTabs(client, message.tabs);
    cloud?.chromeEvent(client, "inventory", previous);
    return;
  }
  if (message.type === "bridge:ping") {
    cloud?.chromeEvent(client, "heartbeat");
    client.send({ type: "bridge:pong", at: Date.now() });
    return;
  }
  if (typeof message.id !== "string") return;
  if (mediaBridge.onMessage(client, message)) return;
  const job = jobs.get(message.id);
  if (!job || job.client !== client || job.done) return;

  if (message.type === "bridge:chunk") {
    const text = typeof message.text === "string" ? message.text : "";
    if (!text) return;
    job.text += text;
    // When tools are present, buffer until complete so we can lift JSON into tool_calls
    // instead of streaming it as ordinary assistant content the IDE will ignore.
    if (job.stream && !job.hasTools) writeChunk(job, text);
    return;
  }
  if (message.type === "bridge:complete") {
    if (typeof message.text === "string" && message.text) {
      if (!job.text || message.text.length >= job.text.length) job.text = message.text;
    }
    finishJob(job);
    return;
  }
  if (message.type === "bridge:error") {
    finishJobWithError(job, typeof message.message === "string" ? message.message : "The web chat page reported an unknown error.");
  }
}

function finishJob(job) {
  if (job.done) return;
  job.done = true;
  clearTimeout(job.timer);
  jobs.delete(job.id);
  if (activeJob === job) activeJob = null;

  if (job.stream) {
    finishStreamingJob(job);
  } else {
    sendCompletion(job.response, job.model, job.text, job.tools);
  }
  dispatchNext();
}

function sendCompletion(response, model, text, tools, media, stream = false) {
  if (stream) {
    const job = { response, id: crypto.randomUUID(), model, text, tools, hasTools: tools.length > 0 };
    startStreamingResponse(job);
    return finishStreamingJob(job);
  }
  const message = media?.length ? { role: "assistant", content: text } : makeAssistantMessage(text, tools);
  sendJson(response, 200, {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }],
    ...(media ? { media } : {}),
  });
}

function finishStreamingJob(job) {
  if (job.hasTools) {
    const message = makeAssistantMessage(job.text, job.tools);
    if (message.tool_calls) {
      const call = message.tool_calls[0];
      writeSse(job.response, makeStreamChunk(job, {
        tool_calls: [{
          index: 0,
          id: call.id,
          type: "function",
          function: { name: call.function.name, arguments: call.function.arguments },
        }],
      }, null));
      writeSse(job.response, makeStreamChunk(job, {}, "tool_calls"));
      writeSse(job.response, "[DONE]");
      job.response.end();
      return;
    }
  }

  if (!job.streamedContent && job.text) writeChunk(job, job.text);
  writeSse(job.response, makeStreamChunk(job, {}, "stop"));
  writeSse(job.response, "[DONE]");
  job.response.end();
}

function finishJobWithError(job, message) {
  if (job.done) return;
  job.done = true;
  clearTimeout(job.timer);
  jobs.delete(job.id);
  const queuedIndex = queue.indexOf(job);
  if (queuedIndex !== -1) queue.splice(queuedIndex, 1);
  if (activeJob === job) activeJob = null;

  if (job.stream) {
    writeSse(job.response, { error: { message, type: "bridge_error", code: "bridge_error" } });
    writeSse(job.response, "[DONE]");
    job.response.end();
  } else {
    sendOpenAiError(job.response, 502, message, "bridge_error");
  }
  dispatchNext();
}

function failJobsForClient(client, message) {
  for (const job of [...jobs.values()]) {
    if (job.client === client) finishJobWithError(job, message);
  }
}

function startStreamingResponse(job) {
  job.response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  job.response.flushHeaders?.();
  // Avoid committing to content:"" when tools may produce tool_calls instead.
  writeSse(job.response, makeStreamChunk(job, job.hasTools ? { role: "assistant" } : { role: "assistant", content: "" }, null));
}

function writeChunk(job, text) {
  job.streamedContent = true;
  writeSse(job.response, makeStreamChunk(job, { content: text }, null));
}

function makeStreamChunk(job, delta, finishReason) {
  return {
    id: `chatcmpl-${job.id}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: job.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function formatPrompt(messages, tools) {
  const transcript = messages.map((message) => {
    const role = typeof message.role === "string" ? message.role.toUpperCase() : "USER";
    return `${role}:\n${contentToText(message.content)}`;
  }).join("\n\n");
  if (!Array.isArray(tools) || tools.length === 0) return transcript;
  return `${transcript}\n\nAVAILABLE TOOLS (OpenAI schema):\n${JSON.stringify(tools)}\n\nIf a tool is required, reply only with a JSON object shaped like {"name":"tool_name","arguments":{...}}. Otherwise answer normally.`;
}

function contentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : String(content);
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (part?.type === "text" && typeof part.text === "string") return part.text;
    if (part?.type === "input_text" && typeof part.text === "string") return part.text;
    return `[Unsupported content part: ${part?.type ?? "unknown"}]`;
  }).join("\n");
}

function providerForModel(model) {
  const value = typeof model === "string" ? model.toLowerCase().trim() : "";
  if (!value || value === "auto" || value === "bridge-auto") return null;
  const found = PROVIDERS.slice(1).find((provider) => (
    value === provider
    || value === `bridge-${provider}`
    || value.includes(`bridge-${provider}`)
    || value === `bridge_${provider}`
    || value.startsWith(`${provider}-`)
    || value.startsWith(`${provider}_`)
  ));
  return found ?? null;
}

function selectClient(provider) {
  const available = [...clients].filter((client) => !client.closed);
  if (!provider) return available.at(-1) ?? null;
  return available.find((client) => client.providers.length === 0 || client.providers.includes(provider)) ?? null;
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        chunks.length = 0;
        reject(new BridgeError(413, "REQUEST_TOO_LARGE", `Request body exceeds ${MAX_BODY_BYTES} bytes.`));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (size > MAX_BODY_BYTES) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(new BridgeError(400, "invalid_request_error", "Request body must be valid JSON."));
      }
    });
    request.on("error", reject);
  });
}

function createWebSocketClient(socket) {
  const client = {
    socket,
    providers: [],
    buffer: Buffer.alloc(0),
    fragments: null,
    fragmentBytes: 0,
    closed: false,
    onClose: null,
    onMessage: null,
    send(value) {
      if (client.closed || socket.destroyed) return;
      sendWebSocketFrame(socket, JSON.stringify(value));
    },
    consume(chunk) {
      client.buffer = Buffer.concat([client.buffer, chunk]);
      while (client.buffer.length >= 2) {
        const first = client.buffer[0];
        const second = client.buffer[1];
        const final = (first & 0x80) !== 0;
        const opcode = first & 0x0f;
        const masked = (second & 0x80) === 0x80;
        if (!masked || (first & 0x70) !== 0) return closeWebSocket(client, 1002, "Invalid frame");
        let payloadLength = second & 0x7f;
        let offset = 2;
        if (payloadLength === 126) {
          if (client.buffer.length < 4) return;
          payloadLength = client.buffer.readUInt16BE(2);
          offset = 4;
        } else if (payloadLength === 127) {
          if (client.buffer.length < 10) return;
          const length = client.buffer.readBigUInt64BE(2);
          if (length > BigInt(MAX_BODY_BYTES)) return closeWebSocket(client, 1009, "Message too large");
          payloadLength = Number(length);
          offset = 10;
        }
        if (opcode >= 0x8 && (!final || payloadLength > 125)) return closeWebSocket(client, 1002, "Invalid control frame");
        const frameLength = offset + (masked ? 4 : 0) + payloadLength;
        if (client.buffer.length < frameLength) return;
        let payload = client.buffer.subarray(offset + (masked ? 4 : 0), frameLength);
        if (masked) {
          const mask = client.buffer.subarray(offset, offset + 4);
          payload = Buffer.from(payload);
          for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
        }
        client.buffer = client.buffer.subarray(frameLength);
        if (opcode === 0x8) return socket.end();
        if (opcode === 0x9) {
          sendWebSocketFrame(socket, payload, 0xA);
          continue;
        }
        if (opcode === 0xA) continue;
        if (opcode === 0x1 && !client.fragments && !final) client.fragments = [];
        else if ((opcode !== 0x1 || client.fragments) && (opcode !== 0x0 || !client.fragments)) {
          return closeWebSocket(client, 1002, "Unexpected frame");
        }
        if (client.fragments) {
          client.fragmentBytes += payload.length;
          if (client.fragmentBytes > MAX_BODY_BYTES) return closeWebSocket(client, 1009, "Message too large");
          client.fragments.push(payload);
          if (!final) continue;
          payload = Buffer.concat(client.fragments, client.fragmentBytes);
          client.fragments = null;
          client.fragmentBytes = 0;
        }
        try {
          client.onMessage?.(JSON.parse(payload.toString("utf8")));
        } catch {
          closeWebSocket(client, 1007, "Invalid JSON");
          return;
        }
      }
    },
  };
  socket.on("data", client.consume);
  socket.on("end", () => socket.destroy());
  socket.on("error", () => socket.destroy());
  socket.on("close", () => {
    if (client.closed) return;
    client.closed = true;
    client.onClose?.();
  });
  return client;
}

function sendWebSocketFrame(socket, payload, opcode = 0x1) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let header;
  if (body.length < 126) {
    header = Buffer.from([0x80 | opcode, body.length]);
  } else if (body.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  socket.write(Buffer.concat([header, body]));
}

function closeWebSocket(client, code, reason) {
  if (client.closed) return;
  const body = Buffer.alloc(2 + Buffer.byteLength(reason));
  body.writeUInt16BE(code, 0);
  body.write(reason, 2);
  sendWebSocketFrame(client.socket, body, 0x8);
  client.socket.end();
}

function rejectUpgrade(socket, status, message) {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function requireApiKey(request) {
  const actual = Buffer.from(request.headers.authorization ?? "");
  const expected = Buffer.from(`Bearer ${apiKey}`);
  if (!apiKey || actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    throw new BridgeError(401, "INVALID_API_KEY", "A valid Bearer API key is required.");
  }
}

function isLoopback(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function setCorsHeaders(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
}

function sendJson(response, status, payload) {
  if (response.bridgeRequestId && !response.bridgeTask && status >= 400) {
    const code = payload.error?.code ?? "INTERNAL_ERROR";
    try { cloud.event("request_error", { request: response.bridgeRequestId, trace: response.bridgeTraceId, code, layer: errorLayer(code) }); }
    catch { console.error("[ai-bridge] Unable to record request error."); }
  }
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function sendOpenAiError(response, status, message, code, param = null) {
  sendJson(response, status, { error: { message, type: code, param, code } });
}

function writeSse(response, payload) {
  response.write(`data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`);
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const [key, inline] = value.slice(2).split("=", 2);
    result[key] = inline ?? values[index + 1];
    if (inline === undefined) index += 1;
  }
  return result;
}

function readPort(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) throw new Error("BRIDGE_PORT must be a valid TCP port.");
  return parsed;
}

function resolveBridgeToken(options) {
  const supplied = options.token ?? process.env.BRIDGE_TOKEN;
  if (supplied) return { token: supplied, path: null };

  const serverDirectory = path.dirname(fileURLToPath(import.meta.url));
  const tokenPath = path.resolve(options.tokenFile ?? options["token-file"] ?? process.env.BRIDGE_TOKEN_FILE ?? path.join(serverDirectory, ".ai-bridge-token"));
  const existing = readTokenFile(tokenPath);
  if (existing) return { token: existing, path: tokenPath };

  const generated = crypto.randomBytes(24).toString("base64url");
  try {
    fs.writeFileSync(tokenPath, `${generated}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return { token: generated, path: tokenPath };
  } catch (error) {
    if (error?.code !== "EEXIST") throw new Error(`Could not create bridge token file at ${tokenPath}: ${error.message}`);
    const tokenCreatedElsewhere = readTokenFile(tokenPath);
    if (tokenCreatedElsewhere) return { token: tokenCreatedElsewhere, path: tokenPath };
    throw new Error(`Bridge token file at ${tokenPath} is empty.`);
  }
}

function loadBridgeSettings(options) {
  const serverDirectory = path.dirname(fileURLToPath(import.meta.url));
  const settingsPath = path.resolve(options.settingsFile ?? options["settings-file"] ?? process.env.BRIDGE_SETTINGS_FILE ?? path.join(serverDirectory, "ai-bridge.settings.json"));
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("the root value must be a JSON object");
    return {
      path: settingsPath,
      settings: {
        interceptTitleRequests: typeof parsed.interceptTitleRequests === "boolean"
          ? parsed.interceptTitleRequests
          : DEFAULT_BRIDGE_SETTINGS.interceptTitleRequests,
        injectPromptInstructionsEveryMessage: typeof parsed.injectPromptInstructionsEveryMessage === "boolean"
          ? parsed.injectPromptInstructionsEveryMessage
          : DEFAULT_BRIDGE_SETTINGS.injectPromptInstructionsEveryMessage,
        prePrompt: readOptionalSettingsString(parsed.prePrompt, DEFAULT_BRIDGE_SETTINGS.prePrompt, "prePrompt"),
        postPrompt: readOptionalSettingsString(parsed.postPrompt, DEFAULT_BRIDGE_SETTINGS.postPrompt, "postPrompt"),
        disguiseModelNameAsAssistant: typeof parsed.disguiseModelNameAsAssistant === "boolean"
          ? parsed.disguiseModelNameAsAssistant
          : DEFAULT_BRIDGE_SETTINGS.disguiseModelNameAsAssistant,
      },
    };
  } catch (error) {
    if (error?.code !== "ENOENT") throw new Error(`Could not load settings file at ${settingsPath}: ${error.message}`);
    const contents = `${JSON.stringify({
      interceptTitleRequests: DEFAULT_BRIDGE_SETTINGS.interceptTitleRequests,
      injectPromptInstructionsEveryMessage: DEFAULT_BRIDGE_SETTINGS.injectPromptInstructionsEveryMessage,
      prePrompt: DEFAULT_BRIDGE_SETTINGS.prePrompt,
      postPrompt: DEFAULT_BRIDGE_SETTINGS.postPrompt,
      "// disguiseModelNameAsAssistant": "Turning on may increase responsiveness of a model to the prompt",
      disguiseModelNameAsAssistant: DEFAULT_BRIDGE_SETTINGS.disguiseModelNameAsAssistant,
    }, null, 2)}\n`;
    try {
      fs.writeFileSync(settingsPath, contents, { encoding: "utf8", flag: "wx" });
    } catch (writeError) {
      if (writeError?.code !== "EEXIST") throw new Error(`Could not create settings file at ${settingsPath}: ${writeError.message}`);
    }
    return loadBridgeSettings({ "settings-file": settingsPath });
  }
}

function resolvePromptInstructionsDirectory(options, settingsPath) {
  const configured = options.promptInstructionsDir
    ?? options["prompt-instructions-dir"]
    ?? process.env.BRIDGE_PROMPT_INSTRUCTIONS_DIR
    ?? path.join(path.dirname(settingsPath), "prompt-instructions");
  return ensurePromptInstructionsLayout(path.resolve(configured));
}

function readOptionalSettingsString(value, fallback, key) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string") throw new Error(`'${key}' must be a string`);
  return value.trim();
}

function readTokenFile(tokenPath) {
  try {
    const token = fs.readFileSync(tokenPath, "utf8").trim();
    return token || null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`Could not read bridge token file at ${tokenPath}: ${error.message}`);
  }
}

function log(message) {
  console.log(`[ai-bridge] ${message}`);
}
