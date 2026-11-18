const PROVIDER = detectProvider(location.hostname);
let runningRequest = null;
let uncertainDocument = false;

const PROVIDER_DISPLAY_NAMES = {
  grok: "Grok",
  gemini: "Gemini",
  deepseek: "DeepSeek",
  perplexity: "Perplexity",
  qwen: "Qwen",
  chatgpt: "ChatGPT",
  claude: "Claude",
  zai: "Z.ai",
  kimi: "Kimi",
};

const SITE_CONFIG = {
  grok: {
    input: ["textarea", "[contenteditable='true'][role='textbox']", "[contenteditable='true']"],
    output: ["[data-testid='conversation-turn'] .markdown", "[data-testid='conversation-turn']", ".message-content"],
  },
  gemini: {
    input: ["rich-textarea [contenteditable='true']", "textarea", "[contenteditable='true'][role='textbox']"],
    output: ["model-response", "message-content", ".model-response", ".message-content"],
  },
  deepseek: {
    input: ["textarea", "[contenteditable='true'][role='textbox']", "[contenteditable='true']"],
    output: [".ds-markdown", "[class*='message-content']", ".markdown-body"],
  },
  perplexity: {
    input: ["textarea", "[contenteditable='true'][role='textbox']", "[contenteditable='true']"],
    output: ["[class*='answer'] .prose", "[class*='prose']", "[data-testid*='answer']"],
  },
  qwen: {
    input: ["textarea", "[contenteditable='true'][role='textbox']", "[contenteditable='true']"],
    output: ["[class*='message-content']", ".markdown-body", "[class*='markdown']"],
  },
  chatgpt: {
    input: ["#prompt-textarea", "textarea", "[contenteditable='true'][role='textbox']"],
    output: ["[data-message-author-role='assistant']"],
  },
  claude: {
    input: ["[contenteditable='true'][role='textbox']", "[contenteditable='true']", "textarea"],
    extractor: "claude",
    streamFinalOnly: true,
  },
  zai: {
    input: ["textarea", "[contenteditable='true'][role='textbox']", "[contenteditable='true']"],
    output: ["[class*='markdown']", "[class*='message-content']"],
  },
  kimi: {
    input: ["textarea", "[contenteditable='true'][role='textbox']", "[contenteditable='true']"],
    output: ["[class*='markdown']", "[class*='message-content']", ".markdown-body"],
  },
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "bridge:probe") {
    sendResponse(pageState());
    return;
  }
  if (message?.type !== "bridge:run") return;
  if (documentBusy()) {
    if (!message.target) report({ type: "bridge:error", id: message.id, message: "This AI chat tab is busy." });
    sendResponse({ ok: false, code: "TAB_BUSY" });
    return;
  }
  if (message.target) {
    if (message.provider !== PROVIDER || message.target.url !== pageUrl()) {
      sendResponse({ ok: false, code: "TAB_STALE" });
      return;
    }
    runPinnedRequest(message);
  } else {
    runRequest(message).catch((error) => report({ type: "bridge:error", id: message.id, message: error.message }));
  }
  sendResponse({ ok: true });
});

report({ type: "bridge:status" });

function documentBusy() {
  return Boolean(runningRequest || uncertainDocument || isGenerating());
}

function pageState() {
  const composer = PROVIDER && findVisible(SITE_CONFIG[PROVIDER].input);
  const adapter = mediaAdapter(PROVIDER, composer);
  const outputKinds = !composer ? [] : adapter?.kind === "video" ? ["video"] : ["text", ...(adapter?.kind ? [adapter.kind] : [])];
  return {
    url: pageUrl(),
    ready: Boolean(composer),
    busy: documentBusy(),
    outputKinds,
    input_image_support: Boolean(adapter?.attach),
  };
}

async function runPinnedRequest({ id, target, prompt, media_kind: kind, input_images: images }) {
  runningRequest = id;
  let clicked = false;
  const reportPinned = (message) => chrome.runtime.sendMessage({
    type: "bridge:site-message", message: { ...message, id },
  });
  const emit = async (message) => {
    const reply = await reportPinned(message).catch(() => null);
    if (!reply?.ok) throw bridgeSiteError("TASK_UNKNOWN", clicked ? "unknown" : "before_submit");
  };
  try {
    const config = SITE_CONFIG[PROVIDER];
    const composer = findVisible(config.input);
    const adapter = mediaAdapter(PROVIDER, composer);
    if (!composer || (kind === "image" || kind === "video") && adapter?.kind !== kind
      || kind === "none" && adapter?.kind === "video") throw bridgeSiteError("TAB_UNSUPPORTED");
    if (images.length && !adapter?.attach) throw bridgeSiteError("INPUT_IMAGE_INVALID");
    const assertPage = () => {
      if (target.url !== pageUrl() || !composer.isConnected) throw bridgeSiteError("TAB_STALE");
      if (isGenerating()) throw bridgeSiteError("TAB_BUSY");
    };
    const assertRoute = () => {
      if (adapter ? !adapter.route(target.url, pageUrl()) : target.url !== pageUrl()) throw bridgeSiteError("TASK_UNKNOWN", "unknown");
    };
    const text = resolvePromptModelName(prompt);
    assertPage();
    if ((composer.value ?? composer.innerText).trim()) throw bridgeSiteError("TAB_BUSY");
    const names = await attachImages(images, adapter?.attach, composer, assertPage);
    assertPage();
    setComposerText(composer, text);
    await delay(120);
    const capture = adapter?.capture(text);
    const previousText = capture ? null : latestResponseText(config);
    const button = adapter ? adapter.button : findSendButton;
    const verifyBeforeSend = () => {
      assertPage();
      if (!uploadedImagesVisible(composer, names)) throw bridgeSiteError("INPUT_IMAGE_INVALID");
      const control = button();
      if (!control || !isVisible(control) || control.disabled || control.getAttribute("aria-disabled") === "true") {
        throw bridgeSiteError("PROMPT_CONTROL_UNAVAILABLE");
      }
      const draft = composer.value ?? composer.innerText;
      if (draft.replace(/\s+/g, " ").trim() !== text.replace(/\s+/g, " ").trim()) throw bridgeSiteError("TAB_BUSY");
      return control;
    };
    verifyBeforeSend();
    await emit({ type: "bridge:submitted", input_images: images.map(({ id, sha256 }) => ({ id, sha256 })) });
    const control = verifyBeforeSend();
    clicked = true;
    control.click();
    let accepted = false;
    const observeSubmission = async () => {
      if (accepted) return;
      accepted = true;
      await emit({ type: "bridge:prompt-sent" });
    };
    const captureKind = kind === "auto" && !adapter?.kind ? "none" : kind;
    const result = capture
      ? await waitForArtifact(capture, captureKind, assertRoute, 28 * 60_000, kind === "none" || kind === "auto", adapter.kind === "video", observeSubmission)
      : { files: [], text: await streamLatestResponse(id, config, previousText, { assertRoute, observeSubmission }) };
    await emit({ type: "bridge:website-completed" });
    const media = await streamMedia(result.files, assertRoute, emit);
    assertRoute();
    await emit({ type: "bridge:complete", text: result.text, media });
  } catch (error) {
    const phase = error.phase ?? (clicked ? "unknown" : "before_submit");
    if (clicked && phase === "unknown") uncertainDocument = true;
    if (clicked && phase === "finished") await reportPinned({ type: "bridge:website-completed" }).catch(() => {});
    await reportPinned({
      type: "bridge:error", code: error.code ?? (clicked ? "TASK_UNKNOWN" : "TAB_UNSUPPORTED"), phase,
    }).catch(() => {});
  } finally {
    runningRequest = null;
    report({ type: "bridge:status" });
  }
}

async function runRequest({ id, prompt }) {
  if (!PROVIDER) throw new Error("This page is not a supported AI chat site.");
  runningRequest = id;
  try {
    const config = SITE_CONFIG[PROVIDER];
    const previousText = latestResponseText(config);
    const composer = findVisible(config.input);
    if (!composer) throw new Error("Could not find the chat composer. Make sure the page is fully loaded and you are signed in.");
    setComposerText(composer, resolvePromptModelName(prompt));
    await delay(80);
    if (!clickSendButton()) {
      composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
      composer.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
    }
    await streamLatestResponse(id, config, previousText);
  } finally {
    runningRequest = null;
  }
}

function resolvePromptModelName(prompt) {
  if (typeof prompt !== "string" || !prompt.includes("{{modelName}}")) return prompt;
  const modelName = PROVIDER_DISPLAY_NAMES[PROVIDER] ?? PROVIDER ?? "the assistant";
  return prompt.replaceAll("{{modelName}}", modelName);
}

function setComposerText(element, text) {
  element.focus();
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value");
    descriptor?.set?.call(element, text);
  } else {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.execCommand("insertText", false, text);
    if (element.textContent?.trim() !== text.trim()) element.textContent = text;
  }
  element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

function findSendButton() {
  const candidates = document.querySelectorAll([
    "button[aria-label*='Send' i]", "button[aria-label*='Submit' i]", "button[aria-label*='发送']",
    "button[data-testid*='send' i]", "button[class*='send' i]",
  ].join(","));
  return [...candidates].find((item) => isVisible(item) && !item.disabled && item.getAttribute("aria-disabled") !== "true");
}

function clickSendButton() {
  const button = findSendButton();
  if (!button) return false;
  button.click();
  return true;
}

async function streamLatestResponse(id, config, beforeText, pinned) {
  let lastText = beforeText;
  let sawResponse = false;
  let sawGenerating = false;
  let lastChangeAt = Date.now();
  const startedAt = Date.now();

  while (Date.now() - startedAt < 230_000) {
    await delay(350);
    pinned?.assertRoute();
    const generating = isGenerating();
    sawGenerating ||= generating;
    const current = latestResponseText(config);
    if (pinned && (generating || current && current !== beforeText)) await pinned.observeSubmission();
    if (current && current !== beforeText) {
      sawResponse = true;
      const delta = current.startsWith(lastText) ? current.slice(lastText.length) : current;
      if (!pinned && delta && !config.streamFinalOnly) report({ type: "bridge:chunk", id, text: delta });
      if (current !== lastText) lastChangeAt = Date.now();
      lastText = current;
    }
    const quietFor = Date.now() - lastChangeAt;
    if (sawResponse && ((!generating && sawGenerating && quietFor > 800) || (!sawGenerating && quietFor > 3500))) {
      if (pinned) return lastText;
      if (config.streamFinalOnly && lastText) report({ type: "bridge:chunk", id, text: lastText });
      report({ type: "bridge:complete", id, text: lastText });
      return;
    }
  }
  throw new Error("Timed out waiting for the AI chat response.");
}

function latestResponseText(config) {
  if (config.extractor === "claude") return latestClaudeResponseText();
  for (const selector of config.output) {
    const matches = [...document.querySelectorAll(selector)].filter(isVisible).map(markdownFromElement);
    const text = matches.at(-1);
    if (text) return text;
  }
  return "";
}

function latestClaudeResponseText() {
  const selector = "[class*='font-claude-response']";
  const blocks = [...document.querySelectorAll(selector)].filter(isVisible);
  if (blocks.length > 0) {
    const latestBlock = blocks.at(-1);
    const root = latestBlock.closest("[data-test-render-count]") ?? latestBlock.parentElement;
    if (!root || root === latestBlock) return markdownFromElement(latestBlock);
    const groupedBlocks = [...root.querySelectorAll(selector)]
      .filter(isVisible)
      .filter((block, _index, all) => !all.some((other) => other !== block && other.contains(block)));
    const text = mergeClaudeResponseBlocks(groupedBlocks.map(markdownFromElement));
    if (text) return text;
  }

  const fallback = [...document.querySelectorAll("[data-test-render-count]")].filter(isVisible).at(-1);
  return fallback ? markdownFromElement(fallback) : "";
}

function mergeClaudeResponseBlocks(blocks) {
  const unique = [];
  for (const block of blocks) {
    if (!block || isClaudeInterimStatus(block)) continue;
    if (unique.some((existing) => existing === block || existing.includes(block))) continue;
    while (unique.length > 0 && block.includes(unique.at(-1))) unique.pop();
    unique.push(block);
  }
  return unique.join("\n\n");
}

function isClaudeInterimStatus(text) {
  return /^(?:musing|thinking|crystallizing|thought for\s+\d+s|recogniz(?:ed|ing)\b.*\b(?:question|request|attempt|integrity)\b)/i.test(text.trim());
}

function markdownFromElement(element) {
  const markdown = renderMarkdownNode(element);
  return cleanMarkdown(markdown) || cleanText(element.innerText);
}

function renderMarkdownNode(node) {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue.replace(/\s+/g, " ");
  if (node.nodeType !== Node.ELEMENT_NODE) return "";

  const tag = node.tagName.toLowerCase();
  const content = () => [...node.childNodes].map(renderMarkdownNode).join("");
  switch (tag) {
    case "br":
      return "\n";
    case "h1": case "h2": case "h3": case "h4": case "h5": case "h6":
      return `\n\n${"#".repeat(Number(tag[1]))} ${cleanMarkdown(content())}\n\n`;
    case "p": case "div": case "section": case "article":
      return `\n\n${content()}\n\n`;
    case "strong": case "b":
      return `**${cleanMarkdown(content())}**`;
    case "em": case "i":
      return `*${cleanMarkdown(content())}*`;
    case "del": case "s":
      return `~~${cleanMarkdown(content())}~~`;
    case "code":
      return `\`${node.textContent.replace(/`/g, "\\`")}\``;
    case "pre":
      return renderCodeBlock(node);
    case "a": {
      const label = cleanMarkdown(content());
      const href = node.getAttribute("href");
      return href && label ? `[${label}](${href})` : label;
    }
    case "blockquote":
      return `\n\n${cleanMarkdown(content()).split("\n").map((line) => `> ${line}`).join("\n")}\n\n`;
    case "ul":
      return renderList(node, false);
    case "ol":
      return renderList(node, true);
    case "table":
      return renderTable(node);
    case "hr":
      return "\n\n---\n\n";
    case "img": {
      const alt = node.getAttribute("alt") ?? "image";
      const src = node.getAttribute("src");
      return src ? `![${alt}](${src})` : alt;
    }
    default:
      return content();
  }
}

function renderCodeBlock(node) {
  const code = node.querySelector("code");
  const source = (code ?? node).textContent.replace(/^\n+|\n+$/g, "");
  const language = [...(code?.classList ?? [])].find((name) => name.startsWith("language-"))?.slice("language-".length) ?? "";
  return `\n\n\`\`\`${language}\n${source}\n\`\`\`\n\n`;
}

function renderList(list, ordered) {
  const items = [...list.children].filter((child) => child.tagName?.toLowerCase() === "li");
  const rendered = items.map((item, index) => {
    const body = [...item.childNodes]
      .filter((child) => !["ul", "ol"].includes(child.tagName?.toLowerCase()))
      .map(renderMarkdownNode)
      .join("");
    const nested = [...item.children]
      .filter((child) => ["ul", "ol"].includes(child.tagName.toLowerCase()))
      .map((child) => indentMarkdown(renderMarkdownNode(child), "    "))
      .join("");
    return `${ordered ? `${index + 1}.` : "-"} ${cleanMarkdown(body)}${nested ? `\n${nested}` : ""}`;
  });
  return `\n\n${rendered.join("\n")}\n\n`;
}

function renderTable(table) {
  const rows = [...table.querySelectorAll("tr")].map((row) => [...row.querySelectorAll(":scope > th, :scope > td")]
    .map((cell) => cleanMarkdown(renderMarkdownNode(cell)).replace(/\|/g, "\\|")));
  if (rows.length === 0 || rows[0].length === 0) return "";
  const width = rows[0].length;
  const normalized = rows.map((row) => [...row, ...Array(Math.max(0, width - row.length)).fill("")].slice(0, width));
  const header = normalized[0];
  const body = normalized.slice(1);
  return `\n\n| ${header.join(" | ")} |\n| ${header.map(() => "---").join(" | ")} |${body.length ? `\n${body.map((row) => `| ${row.join(" | ")} |`).join("\n")}` : ""}\n\n`;
}

function indentMarkdown(value, prefix) {
  return cleanMarkdown(value).split("\n").map((line) => `${prefix}${line}`).join("\n");
}

function cleanMarkdown(value) {
  return value
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isGenerating() {
  return [...document.querySelectorAll("button[aria-label*='Stop' i], button[aria-label*='停止'], button[data-testid*='stop' i]")]
    .some(isVisible);
}

function findVisible(selectors) {
  for (const selector of selectors) {
    const item = [...document.querySelectorAll(selector)].find(isVisible);
    if (item) return item;
  }
  return null;
}

function isVisible(element) {
  const style = getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
}

function cleanText(value) {
  return value.replace(/\u00a0/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function report(message) {
  chrome.runtime.sendMessage({ type: "bridge:site-message", message }).catch(() => {});
}

function detectProvider(host) {
  if (host === "grok.com" || host.endsWith(".grok.com")) return "grok";
  if (host.endsWith("gemini.google.com")) return "gemini";
  if (host.endsWith("chat.deepseek.com")) return "deepseek";
  if (host.endsWith("www.perplexity.ai")) return "perplexity";
  if (host.endsWith("chat.qwen.ai") || host.endsWith("chat.qwenlm.ai")) return "qwen";
  if (host.endsWith("chatgpt.com")) return "chatgpt";
  if (host.endsWith("claude.ai")) return "claude";
  if (host.endsWith("chat.z.ai")) return "zai";
  if (host.endsWith("www.kimi.com") || host.endsWith("kimi.com")) return "kimi";
  return null;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
