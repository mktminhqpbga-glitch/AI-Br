import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolveCname, resolveTxt } from "node:dns/promises";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { BridgeError, UUID, digest } from "./media-store.mjs";

const source = path.dirname(fileURLToPath(import.meta.url));
const exec = promisify(execFile);
const SCOPES = ["read", "generate", "upload", "download"];
const DAY = 86_400_000;
const MODEL = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,79}$/;
const SECRET = /^[a-zA-Z0-9_-]{43}$/;
const id = () => crypto.randomUUID();
const secret = () => crypto.randomBytes(32).toString("base64url");
const denied = (message = "Credentials are missing or invalid.") => new BridgeError(401, "UNAUTHORIZED", message);
const bad = (message) => new BridgeError(422, "INVALID_CONFIGURATION", message);
const missing = () => new BridgeError(404, "NOT_FOUND", "Record not found.");
const safeEqual = (a, b) => crypto.timingSafeEqual(crypto.createHash("sha256").update(a).digest(), crypto.createHash("sha256").update(b).digest());

function httpsOrigin(value) {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && value === url.origin && !url.username && !url.password) return url.origin;
  } catch {}
  throw bad("Use an HTTPS origin without a path, query or credentials.");
}

function jsonState(file, value) {
  const temp = file + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flush: true });
  fs.renameSync(temp, file);
  if (process.platform !== "win32") {
    const directory = fs.openSync(path.dirname(file), "r");
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  }
}

export function errorLayer(code = "", fallback = "gateway") {
  if (/^(?:UNAUTHORIZED|INVALID_API_KEY|INSUFFICIENT_SCOPE|MODEL_|ORIGIN_)/.test(code)) return "auth";
  if (/^TAB_(?:STALE|UNSUPPORTED|REQUIRED|PROVIDER_MISMATCH)/.test(code)) return "tab";
  if (/^(?:TAB_BUSY|TASK_NOT_CANCELLABLE|QUEUE_FULL)/.test(code)) return "routing";
  if (/^PROMPT_/.test(code)) return "prompt";
  if (/^EXTENSION_OFFLINE/.test(code)) return "wss";
  if (code === "TASK_UNKNOWN") return fallback === "gateway" ? "wss" : fallback;
  if (/^INPUT_IMAGE_/.test(code)) return "input";
  if (/^MEDIA_INVALID/.test(code)) return "media";
  if (/^(?:MEDIA_NOT_FOUND|MEDIA_EXPIRED|STORAGE_)/.test(code)) return "storage";
  return fallback;
}

export function createCloudControl({ root, publicUrl, updateUrl, adminPassword, providerLabels, sendJson, profileClients, status, tasks, mediaUsage }) {
  if (typeof adminPassword !== "string" || adminPassword.length < 24) throw new Error("Cloud admin credential is missing or too short.");
  const base = httpsOrigin(publicUrl);
  let updater = null;
  if (updateUrl) {
    try { updater = httpsOrigin(updateUrl.replace(/\/$/, "")); }
    catch { console.warn("[ai-bridge] BRIDGE_UPDATE_URL must be an HTTPS origin."); }
  }
  const file = path.join(root, "control.json");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  let settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {
    keys: [], pairings: [], profiles: [], models: [], origins: [], domains: [], sessions: [],
  };
  const journal = path.join(root, "events.jsonl");
  let events = [];
  let sinceTrim = 0;
  const traceKeys = new Set();
  if (fs.existsSync(journal)) {
    const lines = fs.readFileSync(journal, "utf8").split("\n").filter(Boolean);
    events = lines.flatMap((line, index) => {
      try { return [JSON.parse(line)]; }
      catch (error) { if (index !== lines.length - 1) throw error; return []; }
    });
    trim();
    for (const event of events) if (event.unique) traceKeys.add(event.unique);
  }

  function trim() {
    const cutoff = Date.now() - 30 * DAY;
    events = events.filter((entry) => entry.at >= cutoff);
    const temp = journal + ".tmp";
    fs.writeFileSync(temp, events.map((item) => JSON.stringify(item) + "\n").join(""), { mode: 0o600, flush: true });
    fs.renameSync(temp, journal);
    sinceTrim = 0;
  }

  function update(apply) {
    const next = structuredClone(settings);
    const now = Date.now();
    next.sessions = next.sessions.filter((item) => item.expires > now);
    next.pairings = next.pairings.filter((item) => item.expires > now);
    const result = apply(next);
    jsonState(file, next);
    settings = next;
    return result;
  }

  function event(stage, { trace, request, task, profile, tab, code, layer, once = false } = {}) {
    const task_id = task?.task_id;
    const unique = once && task_id ? task_id + ":" + stage : undefined;
    if (unique && traceKeys.has(unique)) return;
    const entry = {
      at: Date.now(), stage, request_id: request ?? task?.request_id, trace_id: trace ?? task?.trace_id,
      task_id, profile: profile ?? task?.target?.profileInstanceId, tab: tab ?? task?.target?.tabId,
      provider: task?.provider, model: task?.model, media_kind: task?.media_kind,
      ...(code ? { code, layer: errorLayer(code, layer) } : layer ? { layer } : {}),
      ...(unique ? { unique } : {}),
    };
    fs.appendFileSync(journal, JSON.stringify(entry) + "\n", { mode: 0o600, flush: true });
    if (unique) traceKeys.add(unique);
    events.push(entry);
    if (++sinceTrim >= 2048 && events[0].at < Date.now() - 30 * DAY) trim();
  }

  function audit(task, stage, details) {
    event(stage, { task, once: true, ...details });
  }

  const attempts = new Map();
  function throttle(request, group, max) {
    const remote = String(request.headers["x-forwarded-for"] ?? request.socket.remoteAddress).split(",").at(-1).trim().slice(0, 80);
    const key = group + ":" + remote;
    const now = Date.now();
    if (attempts.size >= 2000) for (const [item, record] of attempts) if (record.until <= now) attempts.delete(item);
    let record = attempts.get(key);
    if (!record || record.until <= now) {
      if (attempts.size >= 2000) throw new BridgeError(429, "RATE_LIMIT", "Retry later.");
      record = { count: 0, until: now + 60_000 };
      attempts.set(key, record);
    }
    if (++record.count > max) throw new BridgeError(429, "RATE_LIMIT", "Retry later.");
  }

  function allowed(request) {
    const host = request.headers.host;
    return request.headers["x-forwarded-proto"] === "https"
      && (host === new URL(base).host || settings.domains.some((domain) => domain.verified && host === domain.host));
  }

  function cors(request, response) {
    const origin = request.headers.origin;
    if (!origin) return;
    if (origin !== base && !settings.origins.includes(origin) && !settings.domains.some((domain) => domain.verified && origin === "https://" + domain.host)) {
      throw new BridgeError(403, "ORIGIN_NOT_ALLOWED", "This origin is not allowed.");
    }
    response.setHeader("Vary", "Origin");
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Idempotency-Key");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    response.setHeader("Access-Control-Expose-Headers", "X-Request-Id, X-Trace-Id, X-Task-Id");
  }

  function authorize(request, scope) {
    const value = request.headers.authorization?.match(/^Bearer (aibr_[\w-]{43})$/)?.[1];
    const key = value && settings.keys.find((item) => !item.revoked && item.hash === digest(value));
    if (!key) throw denied();
    if (!key.scopes.includes(scope)) throw new BridgeError(403, "INSUFFICIENT_SCOPE", "The API key does not have the required scope.");
    return key.id;
  }

  function appModels() {
    const tabs = status().tabs;
    return settings.models.filter((model) => model.enabled).map((model) => {
      const eligible = tabs.filter((tab) => tab.provider === model.provider && tab.ready && (!model.target
        || tab.profileInstanceId === model.target.profileInstanceId && tab.tabId === model.target.tabId
          && tab.documentToken === model.target.documentToken && tab.url === model.target.url));
      const kinds = model.kinds.filter((kind) => eligible.some((tab) => tab.outputKinds.includes(kind)));
      return {
        id: model.id, object: "model", owned_by: "ai-bridge", created: 0, provider: model.provider, target: model.target,
        capabilities: { outputKinds: kinds, input_image_support: model.inputImages && eligible.some((tab) => tab.input_image_support) },
      };
    });
  }

  function modelForPayload(payload) {
    const model = settings.models.find((item) => item.id === payload.model && item.enabled);
    if (!model) throw new BridgeError(404, "MODEL_UNAVAILABLE", "The model is not enabled in the control center.");
    const target = payload.target ?? model.target;
    if (!target) throw new BridgeError(422, "TAB_REQUIRED", "Choose a tab or bind this model to a tab.");
    if (model.target && ["profileInstanceId", "tabId", "documentToken", "url"].some((key) => model.target[key] !== target[key])) {
      throw new BridgeError(409, "TAB_STALE", "The target differs from the configured tab.");
    }
    return { target, provider: model.provider, kinds: model.kinds, inputImages: model.inputImages };
  }

  function socketProfile(request, url) {
    if (!allowed(request) || url.search || !/^chrome-extension:\/\/[a-p]{32}$/.test(request.headers.origin ?? "")) return null;
    const protocols = String(request.headers["sec-websocket-protocol"] ?? "").split(/,\s*/);
    const auth = protocols.find((item) => item.startsWith("auth."));
    const token = auth?.slice(5);
    if (!token || !SECRET.test(token) || !protocols.includes("ai-bridge")) return null;
    return settings.profiles.find((item) => !item.revoked && item.hash === digest(token) && item.origin === request.headers.origin) ?? null;
  }

  function chromeEvent(client, stage, previous) {
    if (!client.profileInstanceId) return;
    const profile = client.profileInstanceId;
    if (stage === "heartbeat" || stage === "connected") {
      client.lastHeartbeat = Date.now();
      update((next) => {
        const profile = next.profiles.find((item) => item.profile === client.profileInstanceId);
        if (profile) {
          profile.lastHeartbeat = client.lastHeartbeat;
          profile.version = client.extensionVersion;
        }
      });
    }
    if (stage === "inventory") {
      for (const tab of client.tabs.values()) {
        const old = previous?.get(tab.tabId);
        if (!old || old.documentToken !== tab.documentToken || old.url !== tab.url) {
          event(old ? (old.documentToken === tab.documentToken ? "tab_navigated" : "tab_reloaded") : "tab_detected", { profile, tab: tab.tabId });
        }
      }
      for (const tab of previous?.values() ?? []) if (!client.tabs.has(tab.tabId)) event("tab_removed", { profile, tab: tab.tabId });
      return;
    }
    if (stage === "connected" || stage === "disconnected") {
      const last = events.findLast((item) => item.profile === profile && ["connected", "reconnected", "disconnected"].includes(item.stage));
      event(stage === "connected" && last ? "reconnected" : stage, { profile });
    }
  }

  function profileList() {
    return settings.profiles.map(({ profile, name, pairedAt, revoked, lastHeartbeat, version }) => {
      const client = [...profileClients].find((item) => item.profileInstanceId === profile && !item.socket.destroyed);
      return {
        profile, name, pairedAt, revoked: Boolean(revoked), online: Boolean(client),
        version: client?.extensionVersion ?? version ?? null, lastHeartbeat: client?.lastHeartbeat ?? lastHeartbeat ?? null,
      };
    });
  }

  function stats(entries, allTasks) {
    const count = (stage) => entries.filter((item) => item.stage === stage).length;
    const completed = count("completed");
    const failed = count("failed");
    const unknown = count("unknown");
    const failures = count("request_error") + count("delivery_error");
    const durations = allTasks.filter((task) => task.status === "completed")
      .map((task) => Date.parse(task.updated_at) - Date.parse(task.created_at));
    return {
      api_received: count("api_received"), auth_ok: count("auth_ok"), auth_failure: count("auth_failed"),
      dispatched: count("dispatched"), extension_received: count("extension_received"), completed,
      returned: count("returned"), errors: failures + failed + unknown, queued: status().queued_requests,
      running: Number(Boolean(status().active_request)), unknown: allTasks.filter((item) => item.status === "unknown").length,
      extension_count: status().connected_extensions, tab_count: status().tabs.length,
      provider_count: new Set(status().tabs.filter((tab) => tab.ready).map((tab) => tab.provider)).size,
      average_ms: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
      success_rate: completed + failed + unknown ? completed / (completed + failed + unknown) : null,
    };
  }

  function adminSession(request) {
    const value = request.headers.cookie?.match(/(?:^|;\s*)__Host-aibr=([\w-]{43})(?:;|$)/)?.[1];
    const session = value && settings.sessions.find((item) => item.hash === digest(value) && item.expires > Date.now());
    if (!session) throw denied("Administrator sign-in required.");
    if (request.method !== "GET" && request.headers["x-bridge-csrf"] !== session.csrf) throw denied("Invalid CSRF token.");
    return session;
  }

  async function packageExtension(response, origin) {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-br-extension-"));
    try {
      const directory = path.join(temp, "extension");
      fs.cpSync(path.join(source, "extension"), directory, { recursive: true });
      const manifestFile = path.join(directory, "manifest.json");
      const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
      manifest.host_permissions.push(origin + "/*");
      delete manifest.optional_host_permissions;
      manifest.homepage_url = origin;
      fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
      const archive = path.join(temp, "extension.zip");
      await exec("zip", ["-qr", archive, "extension"], { cwd: temp });
      const bytes = fs.readFileSync(archive);
      response.writeHead(200, { "Content-Type": "application/zip", "Content-Length": bytes.length,
        "Content-Disposition": 'attachment; filename="ai-bridge-extension.zip"', "Cache-Control": "no-store" });
      response.end(bytes);
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  }

  async function route(request, response, url, readJson) {
    const { method } = request;
    const pathname = url.pathname;
    const read = async () => {
      const body = await readJson(request);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw bad("A JSON object is required.");
      return body;
    };
    if (method === "GET" && ["/", "/dashboard.js", "/dashboard.css", "/openapi.json"].includes(pathname)) {
      const asset = { "/": ["index.html", "text/html"], "/dashboard.js": ["dashboard.js", "text/javascript"],
        "/dashboard.css": ["dashboard.css", "text/css"], "/openapi.json": ["openapi.json", "application/json"] }[pathname];
      response.writeHead(200, { "Content-Type": asset[1] + "; charset=utf-8", "Cache-Control": "no-store" });
      return response.end(fs.readFileSync(path.join(source, "cloud-ui", asset[0])));
    }
    if (pathname === "/api/extension/pair" && ["POST", "OPTIONS"].includes(method)) {
      const origin = request.headers.origin ?? "";
      if (!/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) throw denied();
      response.setHeader("Vary", "Origin");
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Access-Control-Allow-Headers", "Content-Type");
      response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      if (method === "OPTIONS") return response.writeHead(204).end();
      throttle(request, "pair", 12);
      const { code, profileInstanceId } = await read();
      if (!UUID.test(profileInstanceId ?? "") || !SECRET.test(code ?? "")) throw denied();
      const key = secret();
      const success = update((next) => {
        const pairing = next.pairings.find((item) => item.hash === digest(code));
        if (!pairing) return false;
        next.pairings.splice(next.pairings.indexOf(pairing), 1);
        next.profiles = next.profiles.filter((item) => item.profile !== profileInstanceId);
        next.profiles.push({ profile: profileInstanceId, origin, name: pairing.name, hash: digest(key), pairedAt: Date.now() });
        return true;
      });
      if (!success) throw denied("Invalid or expired pairing code.");
      for (const ws of profileClients) if (ws.profileInstanceId === profileInstanceId) ws.socket.destroy();
      event("paired", { profile: profileInstanceId });
      return sendJson(response, 201, { credential: key });
    }
    if (!pathname.startsWith("/admin/")) throw missing();
    if (method === "POST" && pathname === "/admin/login") {
      throttle(request, "login", 8);
      if (request.headers.origin !== "https://" + request.headers.host) throw denied();
      const { password } = await read();
      if (typeof password !== "string" || !safeEqual(password, adminPassword)) throw denied();
      const token = secret();
      const csrf = secret();
      update((next) => next.sessions.push({ hash: digest(token), csrf, expires: Date.now() + 8 * 60 * 60_000 }));
      response.setHeader("Set-Cookie", `__Host-aibr=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=28800`);
      return sendJson(response, 200, { csrf });
    }
    const session = adminSession(request);
    if (method === "GET" && pathname === "/admin/session") return sendJson(response, 200, { csrf: session.csrf });
    if (method === "POST" && pathname === "/admin/logout") {
      update((next) => { next.sessions = next.sessions.filter((item) => item.hash !== session.hash); });
      response.setHeader("Set-Cookie", "__Host-aibr=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0");
      return sendJson(response, 200, { ok: true });
    }
    if (method === "GET" && pathname === "/admin/dashboard") {
      const start = Date.parse(url.searchParams.get("from") ?? "");
      const end = Date.parse(url.searchParams.get("to") ?? "");
      const from = Number.isFinite(start) ? start : Date.now() - DAY;
      const to = Number.isFinite(end) ? end : Date.now();
      const period = events.filter((item) => item.at >= from && item.at <= to);
      const allTasks = tasks();
      const timed = allTasks.filter((item) => Date.parse(item.updated_at) >= from && Date.parse(item.updated_at) <= to);
      const matching = timed.filter((item) => ["provider", "model", "status", "media_kind", "tab"].every((filter) => (
        !url.searchParams.has(filter) || url.searchParams.get(filter) === String(filter === "tab" ? item.target.tabId : item[filter])
      )) && (!url.searchParams.has("layer") || events.some((entry) => entry.task_id === item.task_id && entry.layer === url.searchParams.get("layer") && entry.code)));
      return sendJson(response, 200, {
        base_url: base, update_url: updater, inventory: status(), profiles: profileList(), providers: providerLabels, models: settings.models,
        keys: settings.keys.map(({ hash, ...key }) => key), origins: settings.origins, domains: settings.domains,
        stats: stats(period, timed), usage: mediaUsage(), tasks: matching.reverse().slice(0, 200),
        events: period.filter((entry) => !entry.task_id || matching.some((task) => task.task_id === entry.task_id)).slice(-400).reverse(),
      });
    }
    const timeline = pathname.match(/^\/admin\/tasks\/([\w-]+)$/);
    if (method === "GET" && timeline) {
      const task = tasks().find((item) => item.task_id === timeline[1]);
      if (!task) throw missing();
      return sendJson(response, 200, { task, events: events.filter((entry) => entry.task_id === task.task_id || entry.trace_id === task.trace_id)
        .map(({ unique, ...entry }) => entry) });
    }
    if (method === "GET" && pathname === "/admin/extension.zip") {
      const origin = url.searchParams.get("origin") ?? base;
      if (origin !== base && !settings.domains.some((item) => item.verified && origin === "https://" + item.host)) throw bad("Use a verified domain.");
      return packageExtension(response, origin);
    }
    if (method === "POST" && pathname === "/admin/pairings") {
      throttle(request, "new-pairing", 20);
      const { name } = await read();
      const code = secret();
      const expires = Date.now() + 10 * 60_000;
      update((next) => next.pairings.push({ hash: digest(code), expires, name: String(name ?? "").trim().slice(0, 80) || "Chrome" }));
      return sendJson(response, 201, { code, expires });
    }
    if (method === "POST" && pathname === "/admin/keys") {
      const { name, scopes } = await read();
      if (typeof name !== "string" || !name.trim() || name.length > 80 || !Array.isArray(scopes) || !scopes.length
        || scopes.some((scope) => !SCOPES.includes(scope))) throw bad("Supply a name and valid scopes.");
      const key = "aibr_" + secret();
      const record = { id: id(), name, scopes: [...new Set(scopes)], created_at: Date.now(), hash: digest(key) };
      update((next) => next.keys.push(record));
      return sendJson(response, 201, { id: record.id, key });
    }
    const revoke = pathname.match(/^\/admin\/(keys|profiles)\/([\w-]+)$/);
    if (method === "DELETE" && revoke) {
      const revoked = update((next) => {
        const item = next[revoke[1]].find((record) => (record.id ?? record.profile) === revoke[2]);
        if (item) item.revoked = Date.now();
        return Boolean(item);
      });
      if (!revoked) throw missing();
      if (revoke[1] === "profiles") for (const client of profileClients) if (client.profileInstanceId === revoke[2]) client.socket.destroy();
      return sendJson(response, 200, { ok: true });
    }
    if (method === "POST" && pathname === "/admin/models") {
      const { id: modelId, provider, kinds, target, inputImages, enabled } = await read();
      if (!MODEL.test(modelId ?? "") || !Object.hasOwn(providerLabels, provider) || !Array.isArray(kinds)
        || kinds.some((kind) => !["text", "image", "video"].includes(kind))) throw bad("Invalid model, provider or output types.");
      const actual = target && status().tabs.find((tab) => tab.provider === provider
        && ["profileInstanceId", "tabId", "documentToken", "url"].every((key) => tab[key] === target[key]));
      const previous = settings.models.find((model) => model.id === modelId);
      if (target && !actual && JSON.stringify(previous?.target) !== JSON.stringify(target)) throw bad("Choose a tab from the current inventory.");
      const record = {
        id: modelId, provider, kinds: [...new Set(kinds)], enabled: enabled === true, inputImages: inputImages === true,
        target: target ? { profileInstanceId: target.profileInstanceId, tabId: target.tabId, documentToken: target.documentToken, url: target.url } : null,
      };
      update((next) => { next.models = next.models.filter((item) => item.id !== modelId).concat(record); });
      broadcast();
      return sendJson(response, 200, record);
    }
    if (method === "POST" && pathname === "/admin/origins") {
      const { origins } = await read();
      if (!Array.isArray(origins) || origins.length > 50) throw bad("Supply up to 50 HTTPS origins.");
      const checked = [...new Set(origins.map(httpsOrigin))];
      update((next) => { next.origins = checked; });
      return sendJson(response, 200, { origins: checked });
    }
    if (method === "POST" && pathname === "/admin/domains") {
      const { host, verify } = await read();
      if (typeof host !== "string" || host.length > 220 || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]+$/.test(host)) throw bad("Supply a public DNS hostname.");
      const domain = settings.domains.find((item) => item.host === host);
      if (verify) {
        if (!domain) throw missing();
        const records = await resolveTxt("_aibr-verify." + host).catch(() => []);
        if (!records.some((entry) => entry.join("") === "ai-br=" + domain.challenge)) throw bad("The DNS TXT challenge does not match.");
        const cname = await resolveCname(host).catch(() => []);
        const canonicalHost = new URL(base).hostname;
        if (!canonicalHost.endsWith(".onrender.com") || !cname.some((entry) => entry.toLowerCase().replace(/\.$/, "") === canonicalHost)) {
          throw bad("Point this subdomain's CNAME to the canonical onrender.com hostname first.");
        }
        update((next) => { next.domains.find((item) => item.host === host).verified = true; });
        return sendJson(response, 200, { host, verified: true });
      }
      const record = domain ?? { host, challenge: secret(), verified: false };
      if (!domain) update((next) => next.domains.push(record));
      return sendJson(response, 200, record);
    }
    throw missing();
  }

  function config(client) {
    if (!client.profileInstanceId) return;
    client.send({ type: "bridge:config", models: settings.models.filter((model) => model.enabled
      && (!model.target || model.target.profileInstanceId === client.profileInstanceId)) });
  }

  function broadcast() {
    for (const client of profileClients) config(client);
  }

  return { base, allowed, cors, authorize, socketProfile, modelForPayload, appModels, route, event, audit, chromeEvent, config };
}
