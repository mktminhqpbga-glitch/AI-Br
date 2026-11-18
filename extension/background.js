const PROVIDERS = {
  grok: { label: "Grok", home: "https://grok.com/", matches: ["https://grok.com/*"] },
  gemini: { label: "Gemini", home: "https://gemini.google.com/app", matches: ["https://gemini.google.com/*"] },
  deepseek: { label: "DeepSeek", home: "https://chat.deepseek.com/", matches: ["https://chat.deepseek.com/*"] },
  perplexity: { label: "Perplexity", home: "https://www.perplexity.ai/", matches: ["https://www.perplexity.ai/*"] },
  qwen: { label: "Qwen", home: "https://chat.qwen.ai/", matches: ["https://chat.qwen.ai/*", "https://chat.qwenlm.ai/*"] },
  chatgpt: { label: "ChatGPT", home: "https://chatgpt.com/", matches: ["https://chatgpt.com/*"] },
  claude: { label: "Claude", home: "https://claude.ai/", matches: ["https://claude.ai/*"] },
  zai: { label: "Z.ai", home: "https://chat.z.ai/", matches: ["https://chat.z.ai/*"] },
  kimi: { label: "Kimi", home: "https://www.kimi.com/", matches: ["https://www.kimi.com/*"] },
  muse: { label: "Muse", home: "https://muse.ai/thread/new", matches: ["https://muse.ai/*", "https://www.muse.ai/*"] },
};

const DEFAULT_SETTINGS = {
  serverUrl: chrome.runtime.getManifest().homepage_url ?? "http://127.0.0.1:4319",
  cloud: false,
  token: "",
  defaultProvider: "auto",
  paused: false,
};

const HEARTBEAT_INTERVAL_MS = 20_000;
let socket = null;
let reconnectTimer = null;
let heartbeatTimer = null;
let socketState = "disconnected";
let lastError = "";
let closingForPause = false;
let connectionAttempt = 0;
let inventoryTimer = null;
let inventoryScheduled = null;
let inventoryRevision = 0;
const pinnedRuns = new Map();
let cloudModels = null;
chrome.storage.local.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" }).catch(() => {});

const profileId = (async () => {
  const { profileInstanceId } = await chrome.storage.local.get("profileInstanceId");
  if (profileInstanceId) return profileInstanceId;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ profileInstanceId: id });
  return id;
})();

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === "loading" || change.url || change.title || change.status === "complete") {
    scheduleInventory(tabId, change.status === "loading" || Boolean(change.url));
  }
});
chrome.tabs.onRemoved.addListener((tabId) => scheduleInventory(tabId, true));
chrome.tabs.onActivated.addListener(() => scheduleInventory());
chrome.webNavigation.onCommitted.addListener((event) => {
  if (event.frameId === 0) scheduleInventory(event.tabId, true);
});
chrome.webNavigation.onHistoryStateUpdated.addListener((event) => {
  if (event.frameId === 0) scheduleInventory();
});

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(DEFAULT_SETTINGS);
  await chrome.storage.local.set(existing);
  connect();
});

chrome.runtime.onStartup.addListener(connect);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.paused) {
    if (changes.paused.newValue) pauseBridge();
    else connect(true);
    return;
  }
  if (changes.serverUrl || changes.token || changes.cloud) connect(true);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "bridge:get-state") {
    getState().then(sendResponse);
    return true;
  }
  if (message?.type === "bridge:pair-cloud") {
    pairCloud(message.url, message.code).then(() => sendResponse({ ok: true }), () => sendResponse({
      ok: false, error: "Không ghép nối được. Kiểm tra địa chỉ HTTPS và mã một lần.",
    }));
    return true;
  }
  if (message?.type === "bridge:open-provider") {
    openProvider(message.provider).then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "bridge:reconnect") {
    connect(true);
    sendResponse({ ok: true });
    return;
  }
  if (message?.type === "bridge:toggle-pause") {
    chrome.storage.local.get(DEFAULT_SETTINGS).then(async (settings) => {
      await chrome.storage.local.set({ paused: !settings.paused });
      sendResponse({ ok: true, paused: !settings.paused });
    });
    return true;
  }
  if (message?.type === "bridge:site-message") {
    const provider = providerForUrl(sender.url);
    const run = pinnedRuns.get(message.message?.id);
    if (run) {
      relayPinned(message.message, sender, run).then(sendResponse, () => sendResponse({ ok: false }));
      return true;
    }
    if (message.message?.type === "bridge:status") scheduleInventory();
    else sendToServer({ ...message.message, provider });
  }
});

connect();

async function connect(force = false) {
  clearTimeout(reconnectTimer);
  closingForPause = false;
  if (socket && !force && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  const attempt = ++connectionAttempt;
  if (socket) {
    stopHeartbeat();
    socket.onclose = null;
    socket.close();
    socket = null;
  }
  const settings = await chrome.storage.local.get(DEFAULT_SETTINGS);
  if (attempt !== connectionAttempt) return;
  if (settings.paused) {
    socketState = "paused";
    lastError = "";
    updateBadge();
    return;
  }
  if (!settings.token.trim()) {
    socketState = "needs-token";
    lastError = "";
    updateBadge();
    return;
  }
  cloudModels = null;
  socketState = "connecting";
  lastError = "";
  updateBadge();
  try {
    socket = settings.cloud
      ? new WebSocket(toWebSocketUrl(settings.serverUrl, null), ["ai-bridge", "auth." + settings.token])
      : new WebSocket(toWebSocketUrl(settings.serverUrl, settings.token));
  } catch {
    scheduleReconnect("Kiểm tra địa chỉ HTTPS hoặc loopback.");
    return;
  }
  const connection = socket;
  socket.onopen = async () => {
    const profileInstanceId = await profileId;
    if (socket !== connection || connection.readyState !== WebSocket.OPEN) return;
    socketState = "connected";
    lastError = "";
    sendToServer({
      type: "bridge:hello", version: chrome.runtime.getManifest().version,
      providers: Object.keys(PROVIDERS), mediaProtocol: 1, profileInstanceId,
    });
    startHeartbeat();
    inventoryTimer = setInterval(scheduleInventory, 2000);
    scheduleInventory();
    updateBadge();
  };
  socket.onmessage = (event) => {
    try {
      handleServerMessage(JSON.parse(event.data), connection).catch(() => {
        lastError = "The local bridge request could not be processed.";
      });
    } catch {
      lastError = "The local bridge sent invalid data.";
    }
  };
  socket.onerror = () => {
    lastError = "Could not reach the local bridge.";
  };
  socket.onclose = () => {
    stopHeartbeat();
    socket = null;
    if (closingForPause) return;
    socketState = "disconnected";
    updateBadge();
    scheduleReconnect(lastError || "Local bridge disconnected.");
  };
}

function scheduleReconnect(error) {
  lastError = error;
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(async () => {
    const settings = await chrome.storage.local.get(DEFAULT_SETTINGS);
    if (!settings.paused) connect(true);
  }, 3000);
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (socket?.readyState !== WebSocket.OPEN) return stopHeartbeat();
    sendToServer({ type: "bridge:ping", at: Date.now() });
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat() {
  clearInterval(heartbeatTimer);
  clearInterval(inventoryTimer);
  clearTimeout(inventoryScheduled);
  heartbeatTimer = null;
}

function pauseBridge() {
  closingForPause = true;
  connectionAttempt++;
  clearTimeout(reconnectTimer);
  stopHeartbeat();
  socketState = "paused";
  lastError = "";
  if (socket) {
    socket.onclose = null;
    socket.close();
    socket = null;
  }
  updateBadge();
}

async function handleServerMessage(message, connection) {
  if (connection !== socket || !message) return;
  if (message.type === "bridge:config" && Array.isArray(message.models)) {
    cloudModels = message.models;
    return;
  }
  if (typeof message.id !== "string") return;
  if (message.type === "bridge:permit") {
    const run = pinnedRuns.get(message.id);
    if (run?.connection === connection) run.permit?.(true);
    return;
  }
  if (message.type !== "bridge:run") return;
  if (message.target) {
    sendToServer({ type: "bridge:received", id: message.id, target: message.target });
    return runPinned(message, connection);
  }
  const tab = await findTargetTab(message.provider);
  if (!tab?.id) {
    sendToServer({
      type: "bridge:error",
      id: message.id,
      message: message.provider
        ? `Open a logged-in ${PROVIDERS[message.provider]?.label ?? message.provider} tab, then retry.`
        : "Open a logged-in supported AI chat tab, then retry.",
    });
    return;
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "bridge:run", id: message.id, prompt: message.prompt });
    scheduleInventory();
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch {
    sendToServer({ type: "bridge:error", id: message.id, message: "The AI Bridge content script is not ready in the selected tab. Reload that tab and retry." });
  }
}

async function findTargetTab(requestedProvider) {
  const settings = await chrome.storage.local.get(DEFAULT_SETTINGS);
  const provider = requestedProvider || (settings.defaultProvider === "auto" ? null : settings.defaultProvider);
  const patterns = provider ? PROVIDERS[provider]?.matches : Object.values(PROVIDERS).flatMap((item) => item.matches);
  if (!patterns?.length) return null;
  const tabs = await chrome.tabs.query({ url: patterns });
  return tabs.sort((left, right) => Number(Boolean(right.active)) - Number(Boolean(left.active)) || Number(Boolean(right.highlighted)) - Number(Boolean(left.highlighted)))[0] ?? null;
}

function sendToServer(message) {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(message));
  return true;
}

function toWebSocketUrl(serverUrl, token) {
  const url = new URL(serverUrl.trim());
  if (url.username || url.password || (token === null ? url.protocol !== "https:"
    : !["http:", "https:"].includes(url.protocol) || !["127.0.0.1", "localhost"].includes(url.hostname))) {
    throw new Error("Invalid bridge URL");
  }
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/bridge";
  url.search = "";
  url.hash = "";
  if (token !== null) url.searchParams.set("token", token.trim());
  return url.toString();
}

async function pairCloud(value, code) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.origin !== value) throw new Error("HTTPS required");
  const response = await fetch(url.origin + "/api/extension/pair", {
    method: "POST", headers: { "Content-Type": "application/json" }, credentials: "omit",
    redirect: "error", signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({ code, profileInstanceId: await profileId }),
  });
  if (!response.ok) throw new Error("Pairing failed");
  const { credential } = await response.json();
  if (typeof credential !== "string" || !/^[\w-]{43}$/.test(credential)) throw new Error("Invalid device credential");
  await chrome.storage.local.set({ serverUrl: url.origin, token: credential, cloud: true, paused: false });
}

async function openProvider(provider) {
  const item = PROVIDERS[provider];
  if (!item) throw new Error("Unknown provider.");
  const existing = await chrome.tabs.query({ url: item.matches });
  if (existing[0]?.id) {
    await chrome.tabs.update(existing[0].id, { active: true });
    await chrome.windows.update(existing[0].windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url: item.home, active: true });
}

function providerForUrl(url) {
  if (!url) return null;
  return Object.entries(PROVIDERS).find(([, item]) => item.matches.some((pattern) => url.startsWith(pattern.replace("*", ""))))?.[0] ?? null;
}

async function getState() {
  const settings = await chrome.storage.local.get(DEFAULT_SETTINGS);
  return { settings: { ...settings, token: settings.cloud ? "" : settings.token }, socketState, lastError, providers: PROVIDERS };
}

function updateBadge() {
  const text = socketState === "connected" ? "ON" : socketState === "paused" ? "II" : socketState === "needs-token" ? "!" : "×";
  const color = socketState === "connected" ? "#16794a" : socketState === "paused" || socketState === "needs-token" ? "#b7791f" : "#a73737";
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

function publicUrl(value) {
  try {
    const url = new URL(value);
    return url.origin + url.pathname;
  } catch {
    return null;
  }
}

const knownTabs = new Map();

function scheduleInventory(tabId, invalidate = false) {
  if (socketState !== "connected" || socket?.readyState !== WebSocket.OPEN) return;
  const revision = ++inventoryRevision;
  if (invalidate && knownTabs.has(tabId)) {
    // Preserve an in-flight same-document SPA transition. A committed document
    // change is detected by getFrame and receives a new document ID.
    const tab = knownTabs.get(tabId);
    knownTabs.set(tabId, { ...tab, ready: false });
    sendToServer({ type: "bridge:status", tabs: [...knownTabs.values()] });
  }
  clearTimeout(inventoryScheduled);
  inventoryScheduled = setTimeout(() => {
    publishInventory(revision, socket).catch(() => {});
  }, 100);
}

async function inspectTab(tab) {
  const provider = providerForUrl(tab.url);
  if (!provider || tab.id === undefined) return null;
  const frame = await chrome.webNavigation.getFrame({ tabId: tab.id, frameId: 0 }).catch(() => null);
  const url = publicUrl(frame?.url);
  if (!frame?.documentId || !url || providerForUrl(url) !== provider) return null;

  const state = await chrome.tabs.sendMessage(tab.id, { type: "bridge:probe" }, { documentId: frame.documentId }).catch(() => null);
  const current = await chrome.webNavigation.getFrame({ tabId: tab.id, frameId: 0 }).catch(() => null);
  if (current?.documentId !== frame.documentId || publicUrl(current?.url) !== url) return null;
  const usable = state?.url === url && publicUrl(tab.url) === url && tab.status === "complete";
  return {
    tabId: tab.id,
    documentToken: frame.documentId,
    title: tab.title ?? "",
    provider,
    url,
    ready: usable && state.ready === true,
    busy: usable && state.busy === true,
    outputKinds: usable ? state.outputKinds : [],
    input_image_support: usable && state.input_image_support === true,
  };
}

async function publishInventory(revision, connection) {
  const tabs = await chrome.tabs.query({ url: Object.values(PROVIDERS).flatMap((item) => item.matches) });
  const inventory = await Promise.all(tabs.map(inspectTab));
  if (revision !== inventoryRevision || connection !== socket) return;
  knownTabs.clear();
  for (const tab of inventory) if (tab) knownTabs.set(tab.tabId, tab);
  sendToServer({ type: "bridge:status", tabs: [...knownTabs.values()] });
}

async function runPinned(message, connection) {
  const { id, target } = message;
  const fail = (code, phase = "before_submit") => {
    if (connection === socket) sendToServer({ type: "bridge:error", id, target, code, phase });
  };
  if (await profileId !== target.profileInstanceId || connection !== socket) return fail("TAB_STALE");
  const tab = await chrome.tabs.get(target.tabId).catch(() => null);
  const current = tab && await inspectTab(tab);
  if (connection !== socket || !current || current.documentToken !== target.documentToken
    || current.url !== target.url || current.provider !== message.provider) return fail("TAB_STALE");
  if (current.busy || [...pinnedRuns.values()].some((run) => run.target.tabId === tab.id
    && run.target.documentToken === target.documentToken)) return fail("TAB_BUSY");
  const kind = message.media_kind;
  if (cloudModels && !cloudModels.some((model) => model.id === message.model
    && model.provider === message.provider && (kind === "auto" || model.kinds.includes(kind === "none" ? "text" : kind))
    && (!message.input_images.length || model.inputImages)
    && (!model.target || Object.keys(target).every((key) => target[key] === model.target[key])))) return fail("TAB_UNSUPPORTED");
  const kinds = current.outputKinds;
  const supported = kind === "none" ? kinds.includes("text") : kind === "auto" ? kinds.length > 0 : kinds.includes(kind);
  if (!current.ready || !supported || message.input_images.length && !current.input_image_support) return fail("TAB_UNSUPPORTED");

  const run = { target, connection, submitted: false };
  pinnedRuns.set(id, run);
  run.expiration = setTimeout(() => pinnedRuns.delete(id), 36 * 60_000);
  try {
    const reply = await chrome.tabs.sendMessage(tab.id, message, { documentId: target.documentToken });
    if (!reply?.ok) {
      pinnedRuns.delete(id);
      clearTimeout(run.expiration);
      fail(reply?.code ?? "TAB_STALE");
    }
  } catch {
    pinnedRuns.delete(id);
    clearTimeout(run.expiration);
    fail("TAB_STALE", run.submitted ? "unknown" : "before_submit");
  }
  scheduleInventory();
}

async function relayPinned(message, sender, run) {
  const { connection, target } = run;
  if (sender.frameId !== 0 || sender.tab?.id !== target.tabId || sender.documentId !== target.documentToken
    || connection !== socket || connection.readyState !== WebSocket.OPEN) return { ok: false };

  if (message.type === "bridge:submitted") {
    if (run.submitted) return { ok: false };
    const allowed = new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 5000);
      run.permit = (value) => {
        clearTimeout(timer);
        resolve(value);
      };
    });
    sendToServer({ ...message, target });
    run.submitted = await allowed;
    run.permit = null;
    return { ok: run.submitted && connection === socket };
  }

  const waitUntil = Date.now() + 5000;
  while (connection.bufferedAmount > 1024 * 1024 && Date.now() < waitUntil) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (connection !== socket || connection.readyState !== WebSocket.OPEN || connection.bufferedAmount > 1024 * 1024) {
    return { ok: false };
  }
  sendToServer({ ...message, target });
  if (message.type === "bridge:complete" || message.type === "bridge:error") {
    pinnedRuns.delete(message.id);
    clearTimeout(run.expiration);
    scheduleInventory();
  }
  return { ok: true };
}
