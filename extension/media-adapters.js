const MAX_BROWSER_MEDIA_BYTES = 16 * 1024 * 1024;
const MEDIA_CHUNK_BYTES = 192 * 1024;
const MAX_BROWSER_FILES = 4;

function pageUrl() {
  return location.origin + location.pathname;
}

function bridgeSiteError(code, phase = "before_submit") {
  return Object.assign(new Error(code), { code, phase });
}

function chatGptAttachmentInput(composer) {
  const editor = composer.closest("form") ?? composer.closest("[data-type='unified-composer']");
  const input = editor?.querySelector("input[type='file'][multiple]") ?? document.querySelector("input[type='file']#upload-files[multiple]");
  return input && !input.disabled && (!input.accept || /(?:image\/|\.(?:png|jpe?g|webp)\b)/i.test(input.accept)) ? input : null;
}

function chatGptImageMode() {
  const tools = document.querySelectorAll("[data-testid='composer-tool-pill'], [data-testid='create-image'], [data-testid='composer-create-image']");
  return [...tools].some((tool) => isVisible(tool)
    && /^(?:create (?:an? )?image|image|tạo ảnh|hình ảnh)$/i.test((tool.getAttribute("aria-label") ?? tool.textContent).trim()));
}

function mediaAdapter(provider, composer) {
  if (!composer) return null;
  if (provider === "chatgpt" && composer.id === "prompt-textarea"
    && /^(?:\/|\/c\/[\w-]+\/?)$/.test(location.pathname)
    && document.querySelector("[data-testid='composer-plus-btn'], [data-testid='send-button']")) {
    return {
      kind: chatGptImageMode() ? "image" : null,
      attach: chatGptAttachmentInput(composer),
      capture: chatGptCapture,
      button: () => document.querySelector("button[data-testid='send-button']"),
      route: (start, current) => start === current || start === location.origin + "/" && /^\/c\/[\w-]+\/?$/.test(location.pathname),
    };
  }

  if (provider === "grok" && /^\/imagine(?:\/|$)/.test(location.pathname) && grokVideoButton()) {
    return {
      kind: "video",
      capture: grokCapture,
      button: grokVideoButton,
      route: (start, current) => start === current,
    };
  }
  return null;
}

function grokVideoButton() {
  return [...document.querySelectorAll("button")].find((button) => isVisible(button)
    && /^(?:generate|make|create) video$/i.test(button.getAttribute("aria-label") ?? button.textContent.trim()));
}

function imageSource(image, requireLoaded = true) {
  if (requireLoaded && (!image.complete || image.naturalWidth < 256 || image.naturalHeight < 256)) return null;
  try {
    const url = new URL(image.currentSrc || image.src);
    if (url.origin !== location.origin || url.pathname !== "/backend-api/estuary/content" || url.username || url.password
      || !/^file[-_][\w-]+$/.test(url.searchParams.get("id") ?? "")
      || [...url.searchParams.keys()].some((key) => !["id", "ts", "p", "cid", "sig", "v"].includes(key))) return null;
    if (image.srcset || image.closest("picture")) return null;
    return { url: url.href, key: url.searchParams.get("id"), kind: "image" };
  } catch {
    return null;
  }
}

function videoSource(video, requireLoaded = true) {
  if (requireLoaded && (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth
    || !Number.isFinite(video.duration) || video.duration <= 0)) return null;
  try {
    const url = new URL(video.currentSrc || video.src);
    if (url.origin !== "https://assets.grok.com" || url.username || url.password
      || !/^\/users\/[\w-]+\/generated\/[\w-]+\/generated_video\.(?:mp4|webm)$/.test(url.pathname)) return null;
    return { url: url.href, key: url.pathname, kind: "video" };
  } catch {
    return null;
  }
}

const CHAT_TURNS = "[data-message-id][data-message-author-role]";
const GENERATED_IMAGES = "img[alt='Generated image' i]";

function chatGptCapture(prompt) {
  const baseline = new Set([...document.querySelectorAll(CHAT_TURNS)].map((node) => node.dataset.messageId));
  const oldImages = new Set([...document.querySelectorAll(GENERATED_IMAGES)]
    .map((image) => imageSource(image, false)).filter(Boolean).map((item) => item.key));
  const normalize = (value) => value.replace(/\s+/g, " ").trim();
  return () => {
    const newTurns = [...document.querySelectorAll(CHAT_TURNS)].filter((node) => !baseline.has(node.dataset.messageId));
    const userTurns = newTurns.filter((node) => node.dataset.messageAuthorRole === "user");
    if (userTurns.length > 1) throw bridgeSiteError("TASK_UNKNOWN", "unknown");
    const user = userTurns[0];
    if (!user || !normalize(user.innerText).includes(normalize(prompt))) return null;
    const assistant = newTurns.slice(newTurns.indexOf(user) + 1)
      .filter((node) => node.dataset.messageAuthorRole === "assistant").at(-1);
    if (!assistant) return null;
    const images = [...assistant.querySelectorAll(GENERATED_IMAGES)];
    const files = images.map((image) => imageSource(image)).filter((item) => item && !oldImages.has(item.key));
    return { id: assistant.dataset.messageId, text: cleanText(assistant.innerText), files, pending: files.length !== images.length };
  };
}

function grokCapture() {
  const baseline = new Set([...document.querySelectorAll("video")]
    .map((video) => videoSource(video, false)).filter(Boolean).map((file) => file.key));
  const oldPlayers = new Set(document.querySelectorAll("video"));
  return () => {
    const files = [...document.querySelectorAll("video")].filter((video) => !oldPlayers.has(video))
      .map((video) => videoSource(video)).filter((file) => file && !baseline.has(file.key));
    if (!files.length) return null;
    return { id: files.map((file) => file.key).join(","), text: "", files, pending: false };
  };
}

function attachmentMarkers(composer) {
  const editor = composer.closest("form") ?? composer.closest("[data-type='unified-composer']");
  return [...(editor?.querySelectorAll("img[alt], button[aria-label], [data-testid='attachment-name']") ?? [])].filter(isVisible);
}

function uploadedImagesVisible(composer, names) {
  if (!names.length) return true;
  const captions = attachmentMarkers(composer).map((node) => node.getAttribute("alt")
    ?? node.getAttribute("aria-label") ?? node.textContent);
  let previous = -1;
  return names.every((name) => {
    const next = captions.findIndex((caption, index) => index > previous && caption.includes(name));
    if (next === -1) return false;
    previous = next;
    return true;
  }) && !composer.closest("form")?.querySelector("[role='progressbar'], [aria-busy='true']");
}

async function sha256Hex(bytes) {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function referenceFiles(images) {
  const files = [];
  for (const [index, image] of images.entries()) {
    const extension = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }[image.mime_type];
    if (!extension) throw bridgeSiteError("INPUT_IMAGE_INVALID");
    const bytes = Uint8Array.from(atob(image.data), (character) => character.charCodeAt(0));
    if (bytes.length !== image.size || await sha256Hex(bytes) !== image.sha256) throw bridgeSiteError("INPUT_IMAGE_INVALID");
    const name = `bridge-${index + 1}-${crypto.randomUUID().slice(0, 8)}.${extension}`;
    files.push(new File([bytes], name, { type: image.mime_type }));
  }
  return files;
}

function setInputFiles(input, files) {
  const transfer = new DataTransfer();
  for (const file of files) transfer.items.add(file);
  input.files = transfer.files;
  if (input.files.length !== files.length || files.some((file, index) => {
    const attached = input.files[index];
    return attached.name !== file.name || attached.size !== file.size || attached.type !== file.type;
  })) throw bridgeSiteError("INPUT_IMAGE_INVALID");
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

async function attachImages(images, input, composer, assertPage) {
  if (!images.length) return [];
  if (!input?.isConnected || input.files.length || attachmentMarkers(composer).some((node) => (
    node.matches("[data-testid='attachment-name'], img[alt]") || /remove (?:file|attachment)/i.test(node.getAttribute("aria-label") ?? "")
  ))) throw bridgeSiteError("INPUT_IMAGE_INVALID");
  const files = await referenceFiles(images);
  const names = files.map((file) => file.name);
  assertPage();
  setInputFiles(input, files);
  const until = Date.now() + 15_000;
  while (Date.now() < until) {
    assertPage();
    if (uploadedImagesVisible(composer, names)) return names;
    await delay(150);
  }
  throw bridgeSiteError("INPUT_IMAGE_INVALID");
}

async function readFinalMedia(file) {
  const sameOrigin = new URL(file.url).origin === location.origin;
  const response = await fetch(file.url, {
    credentials: sameOrigin ? "same-origin" : "omit", redirect: "error", cache: "no-store",
    referrerPolicy: "no-referrer", signal: AbortSignal.timeout(45_000),
  });
  const mime = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  const validMimes = file.kind === "image" ? ["image/png", "image/jpeg", "image/webp"] : ["video/mp4", "video/webm"];
  if (!response.ok || response.status !== 200 || !response.body || !validMimes.includes(mime)
    || Number(response.headers.get("content-length")) > MAX_BROWSER_MEDIA_BYTES) throw bridgeSiteError("MEDIA_INVALID", "finished");

  const reader = response.body.getReader();
  const data = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BROWSER_MEDIA_BYTES) throw bridgeSiteError("MEDIA_INVALID", "finished");
      data.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  if (!size) throw bridgeSiteError("MEDIA_INVALID", "finished");
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of data) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { bytes, kind: file.kind, mime_type: mime, size, sha256: await sha256Hex(bytes) };
}

function chunkBase64(bytes) {
  let data = "";
  for (let index = 0; index < bytes.length; index += 8192) {
    data += String.fromCharCode(...bytes.subarray(index, index + 8192));
  }
  return btoa(data);
}

async function streamMedia(files, assertRoute, emit) {
  if (files.length > MAX_BROWSER_FILES) throw bridgeSiteError("MEDIA_INVALID", "finished");
  const seen = new Set();
  const metadata = [];
  for (const [index, file] of files.entries()) {
    if (seen.has(file.key)) throw bridgeSiteError("MEDIA_INVALID", "finished");
    seen.add(file.key);
    let output;
    try { output = await readFinalMedia(file); } catch { throw bridgeSiteError("MEDIA_INVALID", "finished"); }
    const { bytes, ...descriptor } = output;
    for (let offset = 0; offset < bytes.length; offset += MEDIA_CHUNK_BYTES) {
      assertRoute();
      const data = chunkBase64(bytes.subarray(offset, offset + MEDIA_CHUNK_BYTES));
      await emit({ type: "bridge:media-chunk", index, offset, data });
    }
    metadata.push(descriptor);
  }
  return metadata;
}

async function waitForArtifact(capture, kind, assertRoute, maxWait, mayUseText, requireGenerating, observeSubmission) {
  let key;
  let changedAt = Date.now();
  let sawGenerating = false;
  const until = Date.now() + maxWait;
  while (Date.now() < until) {
    await delay(350);
    assertRoute();
    const generating = isGenerating();
    sawGenerating ||= generating;
    const result = capture();
    if (generating || result) await observeSubmission();
    if (!result) continue;
    const nextKey = JSON.stringify([result.id, result.text, result.files.map((file) => file.key)]);
    if (nextKey !== key) {
      key = nextKey;
      changedAt = Date.now();
    }
    if (generating || requireGenerating && !sawGenerating) continue;
    if (result.files.length && !result.pending && Date.now() - changedAt >= 2800) {
      return { files: kind === "none" ? [] : result.files, text: result.text };
    }
    if (!result.pending && (result.text || result.finished) && Date.now() - changedAt >= 6500) {
      if (mayUseText && result.text) return { files: [], text: result.text };
      if (sawGenerating || result.finished) throw bridgeSiteError("MEDIA_INVALID", "finished");
    }
  }
  throw bridgeSiteError("TASK_UNKNOWN", "unknown");
}
