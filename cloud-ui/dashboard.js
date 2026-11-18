const $ = (selector) => document.querySelector(selector);
const layers = {
  auth: "Xác thực / cấu hình", gateway: "Gateway / Render", routing: "Hàng đợi / định tuyến", wss: "Kết nối WSS",
  extension: "Tiện ích", tab: "Chọn tab", input: "Ảnh đầu vào", prompt: "Gửi prompt",
  website: "Website AI", media: "Thu và xác minh media", storage: "Lưu trữ / tải xuống", delivery: "Trả phản hồi",
};
const stages = {
  api_received: "Nhận API", auth_ok: "Xác thực đạt", auth_failed: "Xác thực lỗi", queued: "Xếp hàng",
  running: "Đang chạy", dispatched: "Chuyển tới tiện ích", extension_received: "Tiện ích xác nhận nhận",
  attachments_verified: "Xác nhận ảnh đính kèm", prompt_sent: "Website nhận prompt", website_completed: "Website hoàn tất",
  media_uploaded: "Media tới Render", media_saved: "Lưu media", completed: "Hoàn thành", returned: "Trả kết quả",
  downloaded: "Tải tệp", failed: "Thất bại", unknown: "Chưa rõ", cancelled: "Đã hủy", request_error: "Lỗi API",
  input_uploaded: "Đã lưu ảnh tham chiếu", delivery_error: "Lỗi trả kết quả",
  paired: "Đã ghép", connected: "Đã kết nối", reconnected: "Kết nối lại", disconnected: "Mất kết nối",
  tab_detected: "Phát hiện tab", tab_removed: "Tab đã rời inventory", tab_reloaded: "Tab tải lại", tab_navigated: "Đổi trang",
};
const metricLabels = {
  api_received: "Yêu cầu API", dispatched: "Đã chuyển tới tiện ích", extension_received: "Tiện ích đã nhận", completed: "Hoàn thành",
  returned: "Đã trả kết quả", errors: "Lỗi hoặc chưa rõ", queued: "Đang chờ", running: "Đang chạy",
  unknown: "Chưa rõ trạng thái", extension_count: "Tiện ích online", tab_count: "Tab đã nhận diện", provider_count: "AI hoạt động",
  average_ms: "Thời gian trung bình", success_rate: "Tỷ lệ thành công", auth_ok: "Xác thực đạt", auth_failure: "Xác thực lỗi",
};
let active = "overview";
let csrf;
let state;
let pending;
let diagnostic;
const time = (value) => value ? new Date(value).toLocaleString("vi-VN") : "—";
const number = (value) => new Intl.NumberFormat("vi-VN").format(value);
const bytes = (value) => new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 1 }).format(value / 1024 ** 2) + " MiB";

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text != null) element.textContent = text;
  if (className) element.className = className;
  return element;
}
function button(label, action) {
  const item = node("button", label, "secondary");
  item.type = "button";
  item.addEventListener("click", () => perform(action));
  return item;
}
function table(selector, columns, rows) {
  const element = $(selector);
  const head = node("thead");
  const heading = node("tr");
  heading.append(...columns.map((title) => node("th", title)));
  head.append(heading);
  const content = node("tbody");
  if (!rows.length) {
    const row = node("tr");
    const cell = node("td", "Chưa có dữ liệu");
    cell.colSpan = columns.length;
    row.append(cell);
    content.append(row);
  }
  for (const values of rows) {
    const row = node("tr");
    for (const value of values) {
      const cell = node("td");
      cell.append(value instanceof Node ? value : document.createTextNode(value ?? "—"));
      row.append(cell);
    }
    content.append(row);
  }
  element.replaceChildren(head, content);
}
function options(select, items, blank) {
  const selected = select.value;
  select.replaceChildren();
  if (blank !== undefined) select.append(new Option(blank, ""));
  for (const [value, label] of items) select.append(new Option(label, value));
  if ([...select.options].some((option) => option.value === selected)) select.value = selected;
}
function displaySecret(selector, value, detail) {
  const code = node("code", value);
  const wrapper = node("div", null, "secret");
  wrapper.append(node("span", detail), code, button("Sao chép", () => navigator.clipboard.writeText(value)),
    button("Ẩn", () => wrapper.remove()));
  $(selector).replaceChildren(wrapper);
}

async function api(url, method = "GET", body = null) {
  const response = await fetch(url, {
    method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(csrf ? { "X-Bridge-CSRF": csrf } : {}) },
    body: body ? JSON.stringify(body) : null, cache: "no-store",
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message ?? "Yêu cầu thất bại.");
  return data;
}
async function perform(action) {
  const error = $("#error");
  error.hidden = true;
  try { await action(); }
  catch (cause) {
    error.textContent = cause.message;
    error.hidden = false;
  }
}
function form(selector, handler) {
  const item = $(selector);
  item.addEventListener("submit", (event) => {
    event.preventDefault();
    perform(() => handler(new FormData(item), item));
  });
}
function filters() {
  const data = new FormData($(active === "tasks" ? "#task-filters" : "#period"));
  const query = new URLSearchParams();
  for (const [key, value] of data) if (value) query.set(key, ["from", "to"].includes(key) ? new Date(value).toISOString() : value);
  return query;
}
async function refresh() {
  if (pending) return pending;
  pending = api("/admin/dashboard?" + filters()).then((value) => {
    state = value;
    render();
  }).finally(() => { pending = undefined; });
  return pending;
}

function render() {
  const { stats, inventory, profiles, tasks, events, models, keys, usage, domains, origins, base_url: base, update_url: updater } = state;
  $("#online").textContent = stats.extension_count ? stats.extension_count + " tiện ích online" : "Chưa có tiện ích online";
  $("#metrics").replaceChildren(...Object.entries(metricLabels).map(([key, label]) => {
    const value = stats[key];
    const item = node("div", null, "metric");
    const formatted = value === null ? "—" : key === "success_rate" ? number(Math.round(value * 1000) / 10) + "%"
      : key === "average_ms" ? number(Math.round(value / 100) / 10) + " s" : number(value);
    item.append(node("span", label), node("strong", formatted));
    return item;
  }));
  $("#storage").textContent = usage
    ? `${bytes(usage.bytes)} / ${bytes(usage.quota_bytes)} · Lưu tối đa ${number(usage.retention_seconds / 3600)} giờ · Dọn tệp cũ khi vượt ${usage.cleanup_percent}%`
      + (usage.cleanup_error_at ? ` · Lần dọn gần nhất gặp lỗi ${time(usage.cleanup_error_at)}` : "")
    : "Chưa cấu hình.";
  $("#update-link").hidden = !updater;
  if (updater) $("#update-link").href = updater;
  $("#update-hint").textContent = updater ? "Xem commit đang chạy, so sánh với GitHub rồi chọn phiên bản để triển khai."
    : "Đặt BRIDGE_UPDATE_URL thành địa chỉ HTTPS của dịch vụ cập nhật riêng.";
  const providerOptions = Object.entries(state.providers);
  options($("#model-form").provider, providerOptions);
  options($("#task-filters").provider, providerOptions, "Tất cả");
  options($("#task-filters").layer, Object.entries(layers), "Tất cả");
  updateTargets();
  table("#model-table", ["Model", "Nhà cung cấp", "Loại cho phép", "Tab", "Trạng thái", ""],
    models.map((model) => [model.id, state.providers[model.provider], model.kinds.join(", "),
      model.target ? model.target.tabId + " / " + model.target.profileInstanceId : "Client chọn đích",
      model.enabled ? "Đang bật" : "Đã tắt", button("Chỉnh sửa", () => editModel(model))]));
  table("#profile-table", ["Chrome Profile", "Định danh", "Phiên bản", "Trạng thái", "Heartbeat cuối", ""],
    profiles.map((item) => [item.name, item.profile, item.version, item.revoked ? "Đã thu hồi" : item.online ? "Online" : "Offline",
      time(item.lastHeartbeat), item.revoked ? "—" : button("Thu hồi", async () => {
        if (!confirm("Thu hồi quyền kết nối của Chrome Profile này?")) return;
        await api("/admin/profiles/" + item.profile, "DELETE");
        await refresh();
      })]));
  table("#tab-table", ["Tab", "Profile / phiên trang", "AI", "URL", "Trạng thái", "Đầu ra", "Ảnh tham chiếu"],
    inventory.tabs.map((tab) => [`#${tab.tabId} ${tab.title}`, tab.profileInstanceId + " / " + tab.documentToken,
      tab.provider, tab.url, tab.busy ? "Đang bận" : tab.ready ? "Sẵn sàng" : "Chưa sẵn sàng",
      tab.outputKinds.join(", "), tab.input_image_support ? "Có" : "—"]));
  table("#connection-table", ["Thời gian", "Sự kiện", "Profile", "Tab"],
    events.filter((event) => event.profile && !event.task_id).map((event) => [
      time(event.at), stages[event.stage], event.profile, event.tab,
    ]));
  table("#key-table", ["Ứng dụng", "Quyền", "Ngày tạo", "Trạng thái", ""],
    keys.map((key) => [key.name, key.scopes.join(", "), time(key.created_at), key.revoked ? "Đã thu hồi" : "Hoạt động",
      key.revoked ? "—" : button("Thu hồi", async () => {
        if (!confirm("Thu hồi API Key này?")) return;
        await api("/admin/keys/" + key.id, "DELETE");
        await refresh();
      })]));
  table("#domain-table", ["Hostname", "Xác minh DNS", "Trạng thái", ""],
    domains.map((domain) => [domain.host, domain.verified ? "Đã xác minh" : `TXT _aibr-verify.${domain.host} = ai-br=${domain.challenge}`,
      domain.verified ? "Đã bật" : "Chờ xác minh", domain.verified ? "" : button("Kiểm tra DNS", async () => {
        await api("/admin/domains", "POST", { host: domain.host, verify: true });
        await refresh();
      })]));
  options($("#package-form").origin, [base, ...domains.filter((domain) => domain.verified).map((domain) => "https://" + domain.host)]
    .map((origin) => [origin, origin]));
  if (document.activeElement !== $("#origin-form").origins) $("#origin-form").origins.value = origins.join("\n");
  $("#endpoints").replaceChildren(...["/v1", "/v1/chat/completions", "/v1/images/generations", "/v1/videos", "/v1/media/tasks", "/api/bridge/status"]
    .map((route) => {
      const row = node("div", null, "endpoint");
      row.append(node("code", base + route), button("Sao chép", () => navigator.clipboard.writeText(base + route)));
      return row;
    }));
  table("#task-table", ["Task ID", "Model / loại", "Tab", "Trạng thái", "Vị trí lỗi", "Cập nhật", ""],
    tasks.map((task) => [task.task_id, task.model + " / " + task.media_kind, task.target.tabId, stages[task.status], layers[task.error?.layer] ?? task.error?.code,
      time(task.updated_at), button("Truy vết", () => openTimeline(task.task_id))]));
  table("#event-table", ["Thời gian", "Sự kiện", "Mã lỗi", "Tầng", "Trace ID"],
    events.filter((event) => !event.profile || event.task_id).map((event) => [
      time(event.at), stages[event.stage] ?? event.stage, event.code, layers[event.layer], event.trace_id,
    ]));
}
function updateTargets() {
  const f = $("#model-form");
  const candidates = state.inventory.tabs.filter((tab) => tab.provider === f.provider.value);
  const entries = candidates.map((tab) => [JSON.stringify(pickTarget(tab)), `#${tab.tabId} · ${tab.title} · ${tab.profileInstanceId.slice(0, 8)}`]);
  const model = state.models.find((item) => item.id === f.elements.id.value);
  if (model?.target && model.provider === f.provider.value && !entries.some(([value]) => value === JSON.stringify(model.target))) {
    entries.push([JSON.stringify(model.target), `#${model.target.tabId} · Phiên đã ghim, cần chọn lại khi tab đổi`]);
  }
  options(f.elements.namedItem("target"), entries, "MacFlow gửi target rõ ràng");
}
function pickTarget({ profileInstanceId, tabId, documentToken, url }) {
  return { profileInstanceId, tabId, documentToken, url };
}
function editModel(model) {
  const f = $("#model-form");
  f.elements.id.value = model.id;
  f.provider.value = model.provider;
  updateTargets();
  f.elements.namedItem("target").value = model.target ? JSON.stringify(model.target) : "";
  for (const kind of ["text", "image", "video"]) f.elements[kind].checked = model.kinds.includes(kind);
  f.inputImages.checked = model.inputImages;
  f.enabled.checked = model.enabled;
  f.elements.id.focus();
}
async function openTimeline(taskId) {
  diagnostic = await api("/admin/tasks/" + taskId);
  const { task, events } = diagnostic;
  $("#trace-details").textContent = `${task.model} · ${task.provider} · tab #${task.target.tabId} · trace ${task.trace_id}`;
  table("#timeline-table", ["Thời gian", "Sau bước trước", "Sự kiện", "Tầng", "Mã lỗi"],
    events.map((event, index) => [time(event.at), index ? number(event.at - events[index - 1].at) + " ms" : "—",
      stages[event.stage] ?? event.stage, layers[event.layer], event.code]));
  $("#diagnostics").showModal();
}

function sessionReady() {
  $("#sign-in").hidden = true;
  $("#app").hidden = false;
  perform(refresh);
}
form("#login", async (data, form) => {
  try {
    ({ csrf } = await api("/admin/login", "POST", { password: data.get("password") }));
    form.reset();
    $("#login-error").textContent = "";
    sessionReady();
  } catch {
    $("#login-error").textContent = "Không đăng nhập được. Kiểm tra mật khẩu hoặc thử lại sau.";
  }
});
$("#logout").addEventListener("click", () => perform(async () => {
  await api("/admin/logout", "POST", {});
  location.reload();
}));
document.querySelectorAll("nav button").forEach((item) => item.addEventListener("click", () => {
  document.querySelectorAll("nav button").forEach((entry) => entry.removeAttribute("aria-current"));
  item.setAttribute("aria-current", "page");
  active = item.dataset.section;
  document.querySelectorAll(".content > section").forEach((section) => { section.hidden = section.id !== active; });
  $("#page-title").textContent = item.textContent;
  perform(refresh);
}));
$("#refresh").addEventListener("click", () => perform(refresh));
form("#period", refresh);
form("#task-filters", refresh);
$("#model-form").provider.addEventListener("change", updateTargets);
$("#clear-model").addEventListener("click", () => { $("#model-form").reset(); updateTargets(); });
form("#model-form", async (data) => {
  await api("/admin/models", "POST", { id: data.get("id"), provider: data.get("provider"),
    kinds: ["text", "image", "video"].filter((kind) => data.has(kind)),
    enabled: data.has("enabled"), inputImages: data.has("inputImages"),
    target: data.get("target") ? JSON.parse(data.get("target")) : null,
  });
  await refresh();
});
form("#pair-form", async (data) => {
  const result = await api("/admin/pairings", "POST", { name: data.get("name") });
  displaySecret("#pair-result", result.code, "Hết hạn " + time(result.expires));
});
form("#package-form", (data) => {
  location.assign("/admin/extension.zip?origin=" + encodeURIComponent(data.get("origin")));
});
form("#key-form", async (data) => {
  const result = await api("/admin/keys", "POST", { name: data.get("name"), scopes: data.getAll("scope") });
  displaySecret("#key-result", result.key, "Khóa chỉ hiển thị lúc tạo");
  await refresh();
});
form("#origin-form", async (data) => {
  await api("/admin/origins", "POST", { origins: data.get("origins").split(/\s+/).filter(Boolean) });
  await refresh();
});
form("#domain-form", async (data) => {
  await api("/admin/domains", "POST", { host: data.get("host").trim().toLowerCase() });
  await refresh();
});
form("#probe-form", async (data) => {
  const key = data.get("key").trim();
  $("#probe-form").key.value = "";
  const response = await fetch(data.get("path"), { headers: key ? { Authorization: "Bearer " + key } : {} });
  $("#probe-result").textContent = `HTTP ${response.status}\n` + JSON.stringify(await response.json(), null, 2);
  $("#probe-result").hidden = false;
});
$("#close-dialog").addEventListener("click", () => $("#diagnostics").close());
$("#copy-report").addEventListener("click", () => perform(() => {
  const { task, events } = diagnostic;
  const { url, ...target } = task.target;
  const { client_request_id, ...summary } = task;
  return navigator.clipboard.writeText(JSON.stringify({ task: { ...summary, target }, events }, null, 2));
}));
api("/admin/session").then((session) => {
  csrf = session.csrf;
  sessionReady();
}).catch(() => {});
setInterval(() => { if (csrf && !document.hidden) perform(refresh); }, 12_000);
