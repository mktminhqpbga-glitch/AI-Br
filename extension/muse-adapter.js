// Muse composer and receipt handling adapted from ToonFlow-App (HBAI-Ltd, MIT).
// See muse-adapter.LICENSE.txt for the original license.
const MUSE_USERS = '[data-message-author-role="user"], user-query, [class*="chat-user-bubble"], [data-testid*="user-message" i]';
const MUSE_RESPONSES = '[data-message-author-role="assistant"], [class*="assistant-message"], [class*="assistant-bubble"], [class*="hatch-chat-groupable-bubble"]';
const MUSE_ATTACHMENTS = '[data-testid^="hatch-chat-attachment-presentation-"], [data-testid*="attachment-preview" i], [data-testid*="upload-preview" i], [class*="attachment-card" i], [class*="attachmentCard"], [class*="attachment-preview" i], [class*="upload-item" i]';
const MUSE_MEDIA = 'img, video, a[download], [data-download-url], [data-video-src]';
const MUSE_KINDS = ["text", "image", "video"];

function museHost(host) {
  return host === "muse.ai" || host === "www.muse.ai";
}

function museComposer() {
  const candidates = [...document.querySelectorAll("textarea")].filter((node) => (
    isVisible(node) && !node.disabled && !node.readOnly && !node.closest('[hidden], [aria-hidden="true"]')
  ));
  const named = candidates.filter((node) => /message|tin nhắn|消息/i.test((node.placeholder ?? "") + " " + node.getAttribute("aria-label")));
  const choices = named.length ? named : candidates;
  return choices.length === 1 ? choices[0] : null;
}

function museEditor(composer) {
  const containsHistory = (node) => [...node.querySelectorAll(MUSE_USERS + ", " + MUSE_RESPONSES)]
    .some((turn) => !turn.closest('[data-testid="hatch-composer-placeholder-overlay"]'));
  const form = composer.closest("form");
  if (form && !containsHistory(form)) return form;
  let editor = composer;
  for (let parent = composer.parentElement, depth = 0; parent && depth < 8; parent = parent.parentElement, depth++) {
    if (parent.matches("body, main") || containsHistory(parent)
      || [...parent.querySelectorAll("textarea")].some((node) => node !== composer && isVisible(node))) break;
    editor = parent;
    if (parent.matches('[data-testid="hatch-composer"], [data-testid="hatch-chat-composer"]')) break;
  }
  return editor;
}

function museSendIcon(node) {
  if (node.querySelector('svg.lucide-arrow-up, svg.lucide-send, [data-icon="arrow-up"], [data-lucide="arrow-up"]')) return true;
  return [...node.querySelectorAll("svg")].some((svg) => {
    const paths = [...svg.querySelectorAll("path")].map((path) => path.getAttribute("d") ?? "").join("").replace(/[\s,]+/g, "").toLowerCase();
    return /m12(?:19v(?:5|-14)|5v(?:19|14))/.test(paths) && /m5(?:12(?:l)?7-7(?:l)?7(?:7|-?7))/.test(paths);
  });
}

function museSendButton(composer) {
  if (!composer) return null;
  const editor = museEditor(composer);
  for (let scope = editor; scope && !scope.matches("body, main"); scope = scope.parentElement) {
    if (scope !== editor && (scope.querySelector(MUSE_USERS + ", " + MUSE_RESPONSES)
      || [...scope.querySelectorAll("textarea")].some((input) => input !== composer && isVisible(input)))) break;
    const buttons = [...scope.querySelectorAll('button, [role="button"], input[type="submit"]')]
      .filter((node) => isVisible(node) && !node.matches(":disabled") && node.getAttribute("aria-disabled") !== "true");
    const named = buttons.filter((node) => node.matches('[data-testid="hatch-composer-send-button"]')
      || /^(?:send(?: message)?|gửi(?: tin nhắn)?|发送)$/i.test((node.getAttribute("aria-label") || node.title || node.textContent).trim()));
    if (named.length) return named.length === 1 ? named[0] : null;
    const icons = buttons.filter(museSendIcon);
    if (icons.length) return icons.length === 1 ? icons[0] : null;
    const submits = buttons.filter((node) => node.matches('[type="submit"]') && node.closest("form") === composer.closest("form"));
    if (submits.length) return submits.length === 1 ? submits[0] : null;
  }
  return null;
}

function museAttachmentInput(composer) {
  const inputs = [...museEditor(composer).querySelectorAll('input[type="file"]')].filter((input) => (
    !input.disabled && (!input.accept || /(?:\*\/\*|image\/|\.(?:png|jpe?g|webp)\b)/i.test(input.accept))
  ));
  return inputs.length === 1 ? inputs[0] : null;
}

function outermost(nodes) {
  return nodes.filter((node) => !nodes.some((other) => other !== node && other.contains(node)));
}

function museAttachments(composer) {
  return outermost([...museEditor(composer).querySelectorAll(MUSE_ATTACHMENTS)].filter(isVisible));
}

function museAttachmentsReady(composer, count) {
  const editor = museEditor(composer);
  const cards = museAttachments(composer);
  return cards.length === count
    && (count > 0 || !museAttachmentInput(composer)?.files.length)
    && !editor.querySelector('[role="progressbar"], [aria-busy="true"], [data-upload-state="uploading"], [data-upload-state="error"], [data-status="failed"]')
    && cards.every((card) => [...card.querySelectorAll("img")].every((image) => image.complete && image.naturalWidth));
}

async function museAttachImages(images, verifyDraft) {
  const composer = verifyDraft();
  if (!museAttachmentsReady(composer, 0)) throw bridgeSiteError("INPUT_IMAGE_INVALID");
  const files = await referenceFiles(images);
  for (const [index, file] of files.entries()) {
    const control = museAttachmentInput(verifyDraft());
    if (!control) throw bridgeSiteError("INPUT_IMAGE_INVALID");
    setInputFiles(control, [file]);
    const deadline = Date.now() + 60_000;
    let stable = 0;
    while (Date.now() < deadline) {
      if (museAttachmentsReady(verifyDraft(), index + 1)) {
        stable ||= Date.now();
        if (Date.now() - stable >= 1000) break;
      } else stable = 0;
      await delay(150);
    }
    if (!stable || Date.now() - stable < 1000) throw bridgeSiteError("INPUT_IMAGE_INVALID");
  }
}

function museText(node) {
  return (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim();
}

function museVisibleTurns(selector) {
  return outermost([...document.querySelectorAll(selector)].filter((node) => (
    !node.closest('[data-testid="hatch-composer-placeholder-overlay"]')
    && (isVisible(node) || getComputedStyle(node).display === "contents" && [...node.children].some(isVisible))
  )));
}

function museMediaSource(node) {
  const source = node.currentSrc || node.src || node.querySelector("source[src]")?.src
    || node.getAttribute("data-video-src") || node.getAttribute("data-download-url") || node.href;
  if (!source) return null;
  try {
    const url = new URL(source, location.href);
    if (url.protocol === "blob:" && url.origin === location.origin) return url.href;
    if (url.protocol !== "https:" || url.username || url.password || url.port
      || !(url.hostname === "muse.ai" || url.hostname.endsWith(".muse.ai"))
      || /(?:^|[/_-])(?:thumbnail|preview)(?:[/_.-]|$)/i.test(url.pathname)) return null;
    return url.href;
  } catch {
    return null;
  }
}

function museResultFile(nodes, allowed, baseline) {
  for (const kind of ["video", "image"]) {
    if (!allowed.includes(kind)) continue;
    let displayed;
    for (const node of nodes) {
      const url = museMediaSource(node);
      if (!url || baseline.has(url) || node.closest(MUSE_USERS)) continue;
      const hint = (node.getAttribute("type") || "") + " " + (node.getAttribute("download") || "") + " " + url;
      const explicit = node.matches("a[download], [data-download-url]")
        && (kind === "video" ? /video\/|\.(?:mp4|webm)(?:[?#\s]|$)/i : /image\/|\.(?:png|jpe?g|webp)(?:[?#\s]|$)/i).test(hint);
      const player = kind === "video" && node.matches("video") && node.readyState >= 1 && node.videoWidth > 0;
      const image = kind === "image" && node.matches("img") && isVisible(node) && node.complete && node.naturalWidth >= 128 && node.naturalHeight >= 128;
      if (explicit) return { url, key: url, kind };
      if (!displayed && (player || image)) displayed = { url, key: url, kind };
    }
    if (displayed) return displayed;
  }
  return null;
}

function prepareMuseRun(id, prompt, kind, allowed, startUrl) {
  const requestBegin = "[REQUEST_BEGIN:" + id + "]";
  const requestEnd = "[REQUEST_END:" + id + "]";
  const responseBegin = "[RESPONSE_BEGIN:" + id + "]";
  const responseEnd = "[RESPONSE_END:" + id + "]";
  const history = museVisibleTurns(MUSE_USERS).map(museText);
  const baseline = new Set([...document.querySelectorAll(MUSE_MEDIA)].map(museMediaSource));
  const mediaKinds = kind === "none" ? [] : kind === "auto" ? allowed : [kind];
  // Ask for an identifiable receipt and collect only the result fenced by it.
  const instruction = kind === "image" || kind === "video" ? "Generate exactly one " + kind + ". Put the actual file between the response markers."
    : kind === "auto" ? "If generating a file, put the actual file between the response markers." : "Reply in text.";
  const text = instruction + " Begin your response with " + responseBegin + " and end it with " + responseEnd
    + " on separate lines.\n\n" + requestBegin + "\n" + prompt + "\n" + requestEnd;
  const normalized = text.replace(/\s+/g, " ").trim();
  let route = startUrl;
  const initial = new URL(startUrl);
  let confirmed = false;

  function sameHistory(turns) {
    return history.length === turns.length && history.every((value, index) => value === museText(turns[index]));
  }

  function receipt() {
    const turns = museVisibleTurns(MUSE_USERS);
    const matches = turns.filter((turn) => museText(turn).includes(requestBegin) && museText(turn).includes(requestEnd));
    if (!confirmed && matches.length === 0 && sameHistory(turns)) return null;
    if (matches.length !== 1 || turns.at(-1) !== matches[0]
      || !confirmed && (!sameHistory(turns.slice(0, -1)) || !museText(matches[0]).includes(normalized))) {
      throw bridgeSiteError("TASK_UNKNOWN", "unknown");
    }
    confirmed = true;
    return matches[0];
  }

  return {
    text, receipt,
    beforeSend() {
      if (!sameHistory(museVisibleTurns(MUSE_USERS))) throw bridgeSiteError("TAB_BUSY");
    },
    assertRoute() {
      const current = pageUrl();
      if (current === route) return;
      if (route !== startUrl || !/^\/(?:thread\/new\/?)?$/.test(initial.pathname) || location.origin !== initial.origin
        || !/^\/thread\/[\w-]+\/?$/.test(location.pathname) || /^\/thread\/new\/?$/.test(location.pathname)) {
        throw bridgeSiteError("TASK_UNKNOWN", "unknown");
      }
      route = current;
    },
    capture() {
      const turn = receipt();
      if (!turn) return null;
      const responses = museVisibleTurns(MUSE_RESPONSES).filter((node) => (
        !node.contains(turn) && !node.closest(MUSE_USERS) && (turn.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)
      ));
      const starts = responses.filter((node) => museText(node).includes(responseBegin));
      const ends = responses.filter((node) => museText(node).includes(responseEnd));
      if (starts.length !== 1 || ends.length !== 1) return null;
      const [first] = starts;
      const [last] = ends;
      const between = responses.slice(responses.indexOf(first), responses.indexOf(last) + 1);
      const reply = between.map(museText).join("\n");
      const from = reply.indexOf(responseBegin) + responseBegin.length;
      const to = reply.indexOf(responseEnd, from);
      if (!between.length || to < from || reply.indexOf(responseBegin, from) !== -1
        || reply.indexOf(responseEnd) !== to || reply.lastIndexOf(responseEnd) !== to) return null;
      const nodes = first === last ? [...first.querySelectorAll(MUSE_MEDIA)]
        : [...document.querySelectorAll(MUSE_MEDIA)].filter((node) => (
          (first === node || first.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)
          && (last.contains(node) || node.compareDocumentPosition(last) & Node.DOCUMENT_POSITION_FOLLOWING)
        ));
      const file = museResultFile(nodes, mediaKinds, baseline);
      const pending = !file && nodes.some((node) => (
        mediaKinds.includes("image") && node.matches("img") && !node.complete
        || mediaKinds.includes("video") && node.matches("video") && node.readyState === 0
      ));
      return { id, text: cleanText(reply.slice(from, to)), files: file ? [file] : [], pending, finished: true };
    },
  };
}
