import { randomUUID } from "node:crypto";
import {
  BridgeError, MAX_FILES, MAX_INPUT_TOTAL, MAX_MEDIA_SIZE, SHA256, UUID,
  digest, invalidMedia, mediaFormat, readImageUpload,
} from "./media-store.mjs";

const MAX_QUEUE = 10;
const MAX_CHUNK_SIZE = 192 * 1024;
const MEDIA_KINDS = ["none", "auto", "image", "video"];
const PROFILE_VERSION = /^\d+\.\d+\.\d+$/;
const UUID_VALUE = (value) => typeof value === "string" && UUID.test(value);
const unavailable = () => new BridgeError(503, "EXTENSION_OFFLINE", "The selected Chrome profile is offline.");
const stale = () => new BridgeError(409, "TAB_STALE", "The tab document has changed. Select it again.");
const busy = () => new BridgeError(409, "TAB_BUSY", "This tab is busy or its previous submission is unresolved.");
const unsupported = () => new BridgeError(409, "TAB_UNSUPPORTED", "The tab does not support the requested operation.");
const invalidRequest = (message) => new BridgeError(422, "INVALID_REQUEST", message);
const invalidInput = () => new BridgeError(422, "INPUT_IMAGE_INVALID", "Use up to four verified image IDs and at most 16 MiB total.");
const uncertain = (status = 503, code = "TASK_UNKNOWN") => new BridgeError(status, code, "The website may have received the prompt. It was not sent again.");

function sameTarget(left, right) {
  return left?.profileInstanceId === right.profileInstanceId && left.tabId === right.tabId
    && left.documentToken === right.documentToken && left.url === right.url;
}

const tabKey = (target) => `${target.profileInstanceId}/${target.tabId}`;
const requestKey = (owner, id) => owner ? owner + ":" + id : id;
const documentKey = (target) => `${tabKey(target)}/${target.documentToken}`;

function cleanUrl(value) {
  if (typeof value !== "string" || value.length > 4096) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.origin + url.pathname;
  } catch {
    return null;
  }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function publicTask(task) {
  const { task_id, request_id, trace_id, client_request_id, status, model, media_kind, target, created_at, updated_at, media, error, content } = task;
  return {
    task_id, request_id, trace_id, client_request_id, status, model, media_kind, target, created_at, updated_at,
    ...(status === "completed" ? { media, content } : {}),
    ...(error ? { error } : {}),
  };
}

function publicMedia({ id, kind, mime_type, size, sha256 }) {
  return { id, kind, mime_type, size, sha256 };
}

export function createMediaBridge({
  store, clients, providerLabels, providerForModel, createPrompt, complete, sendJson, sendError,
  legacyBusy, legacyQueueLength, dispatch, providerForUrl, timeoutMs = 35 * 60_000, cloud, flushState,
}) {
  const queue = [];
  const tasks = new Map();
  const byRequest = new Map();
  const knownProfiles = new Set();
  const unresolved = new Map();
  const seenOutputs = new Map();
  let active = null;

  function indexTask(task) {
    tasks.set(task.task_id, task);
    if (task.client_request_id) byRequest.set(requestKey(task.owner, task.client_request_id), task);
    if (task.status === "unknown") unresolved.set(documentKey(task.target), task.task_id);
    if (task.status === "completed") {
      const key = tabKey(task.target);
      const hashes = seenOutputs.get(key) ?? new Set();
      for (const file of task.media) hashes.add(file.sha256);
      seenOutputs.set(key, hashes);
    }
  }

  function save(task) {
    store.saveTask(task);
    indexTask(task);
  }

  function transition(task, status, details = {}) {
    const next = { ...task, status, updated_at: new Date().toISOString(), ...details };
    save(next);
    cloud?.audit(next, status, { code: next.error?.code, layer: next.error?.layer });
    return next;
  }

  for (const task of store.restoreTasks()) {
    knownProfiles.add(task.target.profileInstanceId);
    if (task.status === "running") {
      transition(task, "unknown", { error: { code: "TASK_UNKNOWN", message: "The bridge restarted after dispatch. The prompt was not sent again." } });
      continue;
    }
    if (task.status === "queued") {
      transition(task, "cancelled", { error: { code: "TASK_CANCELLED", message: "The bridge restarted before dispatch." } });
      continue;
    }
    indexTask(task);
  }

  function advertisedTabs(client) {
    return client.mediaProtocol ? [...client.tabs.values()] : [];
  }

  function updateTabs(client, entries) {
    if (!client.mediaProtocol || !Array.isArray(entries) || entries.length > 1000) return;
    const tabs = new Map();
    for (const tab of entries) {
      const url = cleanUrl(tab?.url);
      if (!url || !UUID_VALUE(tab.documentToken) || !Number.isSafeInteger(tab.tabId) || tab.tabId < 0
        || !Object.hasOwn(providerLabels, tab.provider) || providerForUrl(url) !== tab.provider) continue;
      const kinds = Array.isArray(tab.outputKinds) ? tab.outputKinds : [];
      tabs.set(tab.tabId, {
        profileInstanceId: client.profileInstanceId,
        tabId: tab.tabId,
        documentToken: tab.documentToken,
        provider: tab.provider,
        title: typeof tab.title === "string" ? tab.title.slice(0, 300) : "",
        url,
        ready: tab.ready === true,
        busy: tab.busy === true,
        outputKinds: ["text", "image", "video"].filter((kind) => kinds.includes(kind)),
        input_image_support: tab.input_image_support === true,
      });
    }
    client.tabs = tabs;
    if (active?.client === client) {
      const tab = tabs.get(active.task.target.tabId);
      if (!tab || tab.documentToken !== active.task.target.documentToken) {
        settle(active, "unknown", uncertain(409, "TAB_STALE"));
      }
    }
  }

  function hello(client, message) {
    if (client.mediaProtocol || message.mediaProtocol !== 1 || !UUID_VALUE(message.profileInstanceId) || !PROFILE_VERSION.test(message.version)) return;
    client.mediaProtocol = 1;
    client.profileInstanceId = message.profileInstanceId;
    client.tabs = new Map();
    knownProfiles.add(client.profileInstanceId);
    for (const previous of clients) {
      if (previous !== client && previous.profileInstanceId === client.profileInstanceId) previous.socket.destroy();
    }
  }

  function closed(client) {
    if (active?.client === client) settle(active, "unknown", uncertain());
  }

  function snapshot(legacyActive) {
    const tabs = [...clients].flatMap(advertisedTabs).map((tab) => ({
      ...tab,
      busy: tab.busy || unresolved.has(documentKey(tab))
        || active?.task.target.tabId === tab.tabId && active.task.target.profileInstanceId === tab.profileInstanceId
        || queue.some((job) => tabKey(job.task.target) === tabKey(tab)),
    }));
    return {
      connected_extensions: clients.size,
      extension_versions: [...clients].map((client) => client.extensionVersion ?? "unknown"),
      providers: Object.entries(providerLabels).map(([id, label]) => ({ id, label })),
      tabs,
      input_image_support: tabs.some((tab) => tab.ready && tab.input_image_support),
      active_request: active?.task.task_id ?? legacyActive ?? null,
      queued_requests: queue.length + legacyQueueLength(),
    };
  }

  function resolveTarget(target, provider, kind, hasInputs, job) {
    const client = [...clients].reverse().find((candidate) => candidate.profileInstanceId === target.profileInstanceId
      && candidate.mediaProtocol && !candidate.closed && !candidate.socket.destroyed);
    if (!client) {
      throw (clients.size === 0 || knownProfiles.has(target.profileInstanceId)) ? unavailable() : stale();
    }
    const tab = client.tabs.get(target.tabId);
    if (!tab || !sameTarget(tab, target)) throw stale();
    if (provider && provider !== tab.provider) throw new BridgeError(409, "TAB_PROVIDER_MISMATCH", "The selected tab does not match the model.");
    if (tab.busy || unresolved.has(documentKey(target))
      || active && active !== job && tabKey(active.task.target) === tabKey(target)
      || queue.some((other) => other !== job && tabKey(other.task.target) === tabKey(target))) throw busy();
    const outputSupported = kind === "none" ? tab.outputKinds.includes("text")
      : kind === "auto" ? tab.outputKinds.length > 0 : tab.outputKinds.includes(kind);
    if (!tab.ready || !outputSupported || hasInputs && !tab.input_image_support) throw unsupported();
    return { client, tab };
  }

  function prepare(payload, asynchronous, response) {
    if (!payload || !Array.isArray(payload.messages) || payload.messages.length === 0
      || payload.messages.some((message) => !message || typeof message !== "object" || Array.isArray(message))) {
      throw invalidRequest("'messages' must be a non-empty array of objects.");
    }
    if (payload.stream !== undefined && payload.stream !== false && !(cloud && !asynchronous && payload.stream === true)) throw invalidRequest("Pinned requests require stream: false.");
    const kind = payload.media_kind === undefined ? "none" : payload.media_kind;
    if (!MEDIA_KINDS.includes(kind)) throw invalidRequest("'media_kind' must be none, auto, image or video.");
    const owner = response.bridgeOwner;
    const ids = payload.input_images === undefined ? [] : payload.input_images;
    if (!Array.isArray(ids) || ids.length > MAX_FILES || ids.some((id) => !UUID_VALUE(id))) throw invalidInput();
    const requestId = asynchronous || cloud ? payload.client_request_id ?? response.bridgeIdempotency : null;
    if ((asynchronous || cloud) && (typeof requestId !== "string" || !/^[\w.:-]{1,128}$/.test(requestId))) {
      throw invalidRequest("Use client_request_id or Idempotency-Key with 1–128 letters, digits, underscores, dots, colons or hyphens.");
    }
    const requestHash = digest(JSON.stringify(canonical(payload)));
    const previous = byRequest.get(requestKey(owner, requestId));
    if (previous) {
      if (previous.request_hash !== requestHash || previous.format !== response.bridgeFormat) {
        throw new BridgeError(409, "REQUEST_ID_CONFLICT", "This client_request_id belongs to a different request.");
      }
      bindResponse(response, previous);
      if (asynchronous) {
        if (previous.status === "completed") returned(response, previous);
        return sendJson(response, 200, publicTask(previous));
      }
      if (previous.status === "completed") return deliver(response, previous, Array.isArray(payload.tools) ? payload.tools : []);
      if (["queued", "running"].includes(previous.status)) {
        throw new BridgeError(409, "TASK_IN_PROGRESS", "This request is already running. Poll its task ID.");
      }
      throw new BridgeError(previous.error?.status ?? 409, previous.error?.code ?? "TASK_UNKNOWN",
        previous.error?.message ?? "Poll this task for its current state.");
    }
    const configured = cloud?.modelForPayload(payload);
    const incoming = configured?.target ?? payload.target;
    const url = cleanUrl(incoming?.url);
    if (!url || incoming.url !== url || !UUID_VALUE(incoming.profileInstanceId) || !UUID_VALUE(incoming.documentToken)
      || !Number.isSafeInteger(incoming.tabId) || incoming.tabId < 0) throw invalidRequest("Use a target from GET /api/bridge/status.");
    const target = { profileInstanceId: incoming.profileInstanceId, tabId: incoming.tabId, documentToken: incoming.documentToken, url };
    const model = payload.model ?? "bridge-auto";
    const provider = configured?.provider ?? providerForModel(model);
    if (typeof model !== "string" || (!provider && !["auto", "bridge-auto"].includes(model))) {
      throw invalidRequest("Choose a model from GET /v1/models.");
    }
    if (payload.stream === true && kind !== "none") throw invalidRequest("Streaming is supported for text only.");
    const allowed = configured?.kinds ?? ["text", "image", "video"];
    if (ids.length && configured && !configured.inputImages || kind !== "auto" && !allowed.includes(kind === "none" ? "text" : kind)) throw unsupported();
    const { tab } = resolveTarget(target, provider, kind, ids.length > 0);
    if (!tab.outputKinds.some((output) => allowed.includes(output))) throw unsupported();
    if (queue.length + legacyQueueLength() >= MAX_QUEUE) throw new BridgeError(429, "QUEUE_FULL", "The bridge queue is full.");
    if (ids.length || kind !== "none" && tab.outputKinds.some((output) => output !== "text")) store.requireValidator();
    let inputSize = 0;
    for (const id of ids) {
      const input = store.inputMetadata(id, owner);
      if (!input || (inputSize += input.size) > MAX_INPUT_TOTAL) throw invalidInput();
    }
    const now = new Date().toISOString();
    const task = {
      task_id: randomUUID(), client_request_id: requestId, request_hash: requestHash, owner,
      request_id: response.bridgeRequestId, trace_id: response.bridgeTraceId,
      request: cloud ? undefined : payload,
      format: response.bridgeFormat, imageEncoding: response.bridgeImageEncoding, stream: payload.stream === true,
      status: "queued", target, model, media_kind: kind, input_images: ids, allowed,
      provider: tab.provider, created_at: now, updated_at: now,
    };
    const { prompt, tools } = createPrompt(payload, tab.provider);
    save(task);
    bindResponse(response, task);
    cloud?.audit(task, "queued");
    queue.push({ task, prompt, tools, releaseInputs: store.pin(ids), response: asynchronous ? null : response });
    if (asynchronous) sendJson(response, 202, publicTask(task));
    dispatch();
  }

  function bindResponse(response, task) {
    if (!cloud) return;
    response.bridgeTask = task.task_id;
    response.setHeader("X-Task-Id", task.task_id);
    response.setHeader("X-Trace-Id", task.trace_id);
  }

  function returned(response, task, stage = "returned") {
    if (cloud) response.once("finish", () => {
      try { cloud.audit(task, stage); } catch { console.error("[ai-bridge] Unable to record delivery event."); }
    });
  }

  function deliver(response, task, tools) {
    if (response.destroyed) return;
    if (task.format === "images") {
      return (async () => {
        const data = [];
        for (const media of task.media) {
          if (task.imageEncoding === "b64_json") {
            const file = await store.readOutput(media.id, task.owner);
            if (!file) throw new BridgeError(404, "MEDIA_NOT_FOUND", "The verified file is unavailable.");
            data.push({ b64_json: file.bytes.toString("base64") });
          } else {
            data.push({ url: cloud.base + "/v1/media/" + media.id });
          }
        }
        returned(response, task);
        sendJson(response, 200, { created: Math.floor(Date.parse(task.created_at) / 1000), data, media: task.media });
      })().catch((error) => {
        cloud.audit(task, "delivery_error", { code: error.code ?? "STORAGE_ERROR", layer: "delivery" });
        if (!response.destroyed) sendError(response, error.status ?? 502, error.message, error.code ?? "STORAGE_ERROR");
      });
    }
    returned(response, task);
    return complete(response, task.model, task.content, tools, task.media, task.stream);
  }

  function startNext() {
    if (active || legacyBusy()) return true;
    const job = queue.shift();
    if (!job) return false;
    active = job;
    dispatchJob(job);
    return true;
  }

  async function dispatchJob(job) {
    try {
      const input = [];
      for (const id of job.task.input_images) {
        const file = await store.readInput(id, job.task.owner, true);
        if (active !== job) return;
        if (!file) throw invalidInput();
        input.push({ ...file.metadata, data: file.bytes.toString("base64") });
      }
      const { client, tab } = resolveTarget(job.task.target, job.task.provider, job.task.media_kind, input.length > 0, job);
      const policy = cloud?.modelForPayload({ model: job.task.model, target: job.task.target });
      if (policy && (input.length && !policy.inputImages
        || job.task.media_kind !== "auto" && !policy.kinds.includes(job.task.media_kind === "none" ? "text" : job.task.media_kind))) throw unsupported();
      const output = tab.outputKinds.filter((kind) => job.task.allowed.includes(kind) && (!policy || policy.kinds.includes(kind)));
      if (!output.length) throw unsupported();
      job.task = transition(job.task, "running");
      job.client = client;
      job.outputKinds = output;
      job.attachments = input.map(({ id, sha256 }) => ({ id, sha256 }));
      job.files = new Map();
      job.bytes = 0;
      job.timer = setTimeout(() => settle(job, "unknown", uncertain(504)), timeoutMs);
      client.send({
        type: "bridge:run", id: job.task.task_id, provider: job.task.provider, target: job.task.target, model: job.task.model,
        media_kind: job.task.media_kind === "auto" && output.length === 1 ? (output[0] === "text" ? "none" : output[0]) : job.task.media_kind,
        prompt: job.prompt, input_images: input, request_id: job.task.request_id, trace_id: job.task.trace_id,
      });
      cloud?.audit(job.task, "dispatched");
    } catch (error) {
      if (active !== job) return;
      settle(job, job.client ? "unknown" : "failed", job.client ? uncertain() : error);
    }
  }

  function verifySubmission(job, message) {
    const attachments = message.input_images;
    if (!Array.isArray(attachments) || attachments.length !== job.task.input_images.length) return false;
    return attachments.every((attachment, index) => {
      const expected = job.attachments[index];
      return attachment?.id === expected.id && attachment.sha256 === expected.sha256;
    });
  }

  function receiveChunk(job, message) {
    if (!job.submitted || job.finalizing || job.task.media_kind === "none") throw invalidMedia();
    const { index, offset, data } = message;
    if (!Number.isInteger(index) || index < 0 || index >= MAX_FILES || typeof data !== "string"
      || data.length > MAX_CHUNK_SIZE * 4 / 3 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw invalidMedia();
    const file = job.files.get(index) ?? { chunks: [], size: 0 };
    const bytes = Buffer.from(data, "base64");
    if (bytes.length === 0 || bytes.toString("base64") !== data || offset !== file.size
      || file.size + bytes.length > MAX_MEDIA_SIZE || job.bytes + bytes.length > MAX_FILES * MAX_MEDIA_SIZE) throw invalidMedia();
    file.chunks.push(bytes);
    file.size += bytes.length;
    job.bytes += bytes.length;
    job.files.set(index, file);
  }

  async function completeMedia(job, message) {
    const { media } = message;
    const kind = job.task.media_kind;
    if (!job.submitted || !Array.isArray(media) || media.length !== job.files.size || media.length > MAX_FILES
      || job.task.format === "images" && media.length !== 1
      || (kind === "image" || kind === "video") && media.length === 0
      || media.length === 0 && !job.outputKinds.includes("text")) throw invalidMedia();
    if (media.length) cloud?.audit(job.task, "media_uploaded");
    const saved = [];
    const releaseOutputs = store.pin([job.task.task_id]);
    try {
      for (const [index, descriptor] of media.entries()) {
        const file = job.files.get(index);
        const format = mediaFormat(descriptor?.mime_type);
        if (!file || !format || !job.outputKinds.includes(format.kind) || descriptor.kind !== format.kind
          || (kind === "image" || kind === "video") && format.kind !== kind
          || descriptor.size !== file.size || !SHA256.test(descriptor.sha256)
          || seenOutputs.get(tabKey(job.task.target))?.has(descriptor.sha256)
          || saved.some((item) => item.sha256 === descriptor.sha256)) throw invalidMedia();
        const bytes = Buffer.concat(file.chunks, file.size);
        saved.push(await store.saveOutput(bytes, descriptor.mime_type, descriptor.sha256, job.task.task_id, job.task.owner));
        if (active !== job) return;
      }
      if (saved.length) cloud?.audit(job.task, "media_saved");
      settle(job, "completed", null, {
        media: saved.map(publicMedia),
        content: typeof message.text === "string" ? message.text.slice(0, 100_000) : "",
      });
    } finally {
      if (job.task.status !== "completed") for (const file of saved) await store.removeOutput(file.id).catch(() => {});
      releaseOutputs();
    }
  }

  function onMessage(client, message) {
    const job = active;
    if (!job || job.client !== client || message.id !== job.task.task_id) return false;
    if (message.type === "bridge:chunk") return true;
    if (!sameTarget(message.target, job.task.target)) return true;
    if (job.finalizing) return true;
    try {
      switch (message.type) {
        case "bridge:received":
          cloud?.audit(job.task, "extension_received");
          break;
        case "bridge:prompt-sent":
          if (job.submitted) cloud?.audit(job.task, "prompt_sent");
          break;
        case "bridge:website-completed":
          if (job.submitted) cloud?.audit(job.task, "website_completed");
          break;
        case "bridge:submitted":
          if (job.submitted || !verifySubmission(job, message)) throw invalidInput();
          job.submitted = true;
          cloud?.audit(job.task, "attachments_verified");
          client.send({ type: "bridge:permit", id: job.task.task_id });
          break;
        case "bridge:media-chunk":
          receiveChunk(job, message);
          break;
        case "bridge:complete":
          job.finalizing = true;
          completeMedia(job, message).catch((error) => {
            if (active === job) settle(job, "failed", error);
          });
          break;
        case "bridge:error": {
          if (message.phase === "before_submit") {
            const error = message.code === "TAB_STALE" ? stale() : message.code === "TAB_BUSY" ? busy()
              : message.code === "INPUT_IMAGE_INVALID" ? invalidInput() : message.code === "PROMPT_CONTROL_UNAVAILABLE"
                ? new BridgeError(409, "PROMPT_CONTROL_UNAVAILABLE", "The website send control is unavailable.") : unsupported();
            settle(job, "failed", error, null, true, "extension");
          } else if (message.phase === "finished" && job.submitted && message.code === "MEDIA_INVALID") {
            settle(job, "failed", invalidMedia());
          } else {
            settle(job, "unknown", uncertain(), null, true, "website");
          }
          break;
        }
      }
    } catch (error) {
      settle(job, job.submitted ? "unknown" : "failed", error);
    }
    return true;
  }

  function settle(job, state, error, result, advance = true, layer) {
    clearTimeout(job.timer);
    job.releaseInputs();
    const safeError = error instanceof BridgeError ? error
      : new BridgeError(500, "STORAGE_ERROR", "Unable to save the task on the bridge host.");
    try {
      job.task = transition(job.task, state, result ?? { error: { code: safeError.code, message: safeError.message, ...(cloud ? { status: safeError.status, layer } : {}) } });
    } catch {
      indexTask({ ...job.task, status: "unknown", error: { code: "TASK_UNKNOWN", message: uncertain().message } });
      // A running record remains durable if the terminal write failed.
      if (job.response && !job.response.destroyed) sendError(job.response, 500, "Unable to save the task on the bridge host.", "STORAGE_ERROR");
      if (active === job) active = null;
      if (advance) dispatch();
      return;
    }
    if (active === job) active = null;
    if (job.response && !job.response.destroyed) {
      if (result) deliver(job.response, job.task, job.tools);
      else sendError(job.response, safeError.status, safeError.message, safeError.code);
    }
    if (advance) dispatch();
  }

  async function route(request, response, pathname, readJson, legacyActive) {
    if (pathname === "/api/bridge/status" && request.method === "GET") return sendJson(response, 200, snapshot(legacyActive));
    if (pathname === "/v1/input-images" && request.method === "POST") {
      const { bytes, mime } = await readImageUpload(request);
      const image = await store.saveInput(bytes, mime, response.bridgeOwner);
      cloud?.event("input_uploaded", { request: response.bridgeRequestId, trace: response.bridgeTraceId, layer: "input" });
      return sendJson(response, 201, image);
    }
    if (pathname === "/v1/media/tasks" && request.method === "POST") return prepare(await readJson(request), true, response);
    const taskMatch = pathname.match(/^\/v1\/media\/tasks\/([^/]+)$/);
    if (taskMatch && (request.method === "GET" || request.method === "DELETE")) {
      const id = taskMatch[1];
      if (!UUID_VALUE(id)) throw invalidRequest("Use a task UUID returned by POST /v1/media/tasks.");
      const task = tasks.get(id);
      if (!task || cloud && task.owner !== response.bridgeOwner) return sendJson(response, 404, {
        task_id: id, status: "unknown", error: { code: "TASK_NOT_FOUND", message: "The bridge has no record of this task." },
      });
      bindResponse(response, task);
      if (request.method === "GET") {
        if (task.status === "completed") returned(response, task);
        return sendJson(response, 200, publicTask(task));
      }
      const index = queue.findIndex((job) => job.task.task_id === task.task_id);
      let job = index !== -1 ? queue.splice(index, 1)[0] : null;
      if (active?.task === task && task.status === "queued") job = active;
      if (!job) throw new BridgeError(409, "TASK_NOT_CANCELLABLE", "Only queued tasks can be cancelled.");
      settle(job, "cancelled", new BridgeError(409, "TASK_CANCELLED", "The task was cancelled before dispatch."));
      return sendJson(response, 200, publicTask(job.task));
    }
    const fileMatch = pathname.match(/^\/v1\/media\/([^/]+)$/);
    if (fileMatch && request.method === "GET") {
      const file = await store.readOutput(fileMatch[1], response.bridgeOwner);
      const task = file && tasks.get(file.metadata.taskId);
      if (!task?.media?.some((item) => item.id === file.metadata.id) || task.status !== "completed") {
        throw new BridgeError(404, "MEDIA_NOT_FOUND", "The requested verified file is unavailable.");
      }
      bindResponse(response, task);
      if (flushState) await flushState();
      returned(response, task, "downloaded");
      response.writeHead(200, {
        "Content-Type": file.metadata.mime_type,
        "Content-Length": file.metadata.size,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      });
      return response.end(file.bytes);
    }
    throw new BridgeError(404, "not_found", "Route not found.");
  }

  return {
    hello, updateTabs, closed, startNext, onMessage, route,
    prepare: (payload, response, async = false) => prepare(payload, async, response),
    snapshot,
    listTasks: () => [...tasks.values()].map((task) => ({ ...publicTask(task), content: undefined, provider: task.provider })),
    get activeId() { return active?.task.task_id; },
    get queued() { return queue.length; },
  };
}
