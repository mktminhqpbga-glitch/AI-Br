const $ = (selector) => document.querySelector(selector);
let csrf;
let plan;
let busy = false;
let polling;
const translations = {
  live: "Đang chạy", created: "Đã nhận deploy", queued: "Đang chờ",
  build_in_progress: "Đang build", update_in_progress: "Đang khởi động",
  pre_deploy_in_progress: "Đang chạy bước tiền triển khai", deactivated: "Đã thay thế",
  build_failed: "Build lỗi", update_failed: "Khởi động lỗi", pre_deploy_failed: "Tiền triển khai lỗi",
  canceled: "Đã hủy", rejected: "Render từ chối", submitting: "Đang gửi", unconfirmed: "Chưa xác minh",
};

async function api(url, payload) {
  const response = await fetch(url, payload ? {
    method: "POST", headers: { "Content-Type": "application/json", "X-Updater-CSRF": csrf ?? "" },
    body: JSON.stringify(payload),
  } : undefined);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message ?? "Không thực hiện được yêu cầu.");
  return data;
}

function render(value) {
  plan = value;
  $("#target").textContent = `${value.serviceName} · ${value.repo} · ${value.branch}`;
  $("#current").textContent = value.current ?? "Chưa có bản đang chạy";
  $("#candidate").textContent = value.candidate;
  $("#compare").hidden = !value.compareUrl;
  if (value.compareUrl) $("#compare").href = value.compareUrl;
  $("#state").textContent = value.busy ? "Đang cập nhật hoặc đang chờ xác minh yêu cầu trước."
    : value.canDeploy ? `Có ${value.ahead} commit mới nối tiếp phiên bản đang chạy.`
      : value.relation === "identical" ? "Đang chạy commit mới nhất."
        : value.relation === "no_live" ? "Cần triển khai lần đầu cho gateway trên Render."
          : "Lịch sử Git không nối tiếp phiên bản đang chạy. Hãy kiểm tra trước khi cập nhật.";
  $("#commits").replaceChildren(...value.commits.map(({ sha, title }) => {
    const row = document.createElement("li");
    row.textContent = `${sha.slice(0, 7)} · ${title}`;
    return row;
  }));
  $("#history").replaceChildren(...value.history.map(({ from, sha, status, startedAt }) => {
    const row = document.createElement("tr");
    for (const entry of [new Date(startedAt).toLocaleString("vi-VN"), from.slice(0, 7), sha.slice(0, 7), translations[status] ?? status]) {
      const cell = document.createElement("td");
      cell.textContent = entry;
      row.append(cell);
    }
    return row;
  }));
}

async function operate(action) {
  if (busy) return;
  busy = true;
  $("#deploy").disabled = true;
  $("#refresh").disabled = true;
  $("#error").hidden = true;
  try { await action(); }
  catch (error) {
    plan = undefined;
    $("#error").textContent = error.message;
    $("#error").hidden = false;
  } finally {
    busy = false;
    $("#refresh").disabled = false;
    $("#deploy").disabled = !plan?.canDeploy;
  }
}

async function refresh() { render(await api("/api/preview")); }

function signIn(session) {
  csrf = session.csrf;
  $("#login-view").hidden = true;
  $("#app").hidden = false;
  operate(refresh);
  polling = setInterval(() => { if (plan?.busy && !document.hidden) operate(refresh); }, 15_000);
}

$("#login").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector("button");
  if (submit.disabled) return;
  submit.disabled = true;
  $("#login-error").textContent = "";
  try {
    const session = await api("/api/login", { password: new FormData(form).get("password") });
    form.reset();
    signIn(session);
  } catch (error) { $("#login-error").textContent = error.message; }
  finally { submit.disabled = false; }
});
$("#refresh").addEventListener("click", () => operate(refresh));
$("#deploy").addEventListener("click", () => operate(async () => {
  if (!plan?.canDeploy || !confirm(`Triển khai commit ${plan.candidate.slice(0, 7)} lên ${plan.serviceName}?`)) return;
  const { current, candidate } = plan;
  plan = undefined;
  const result = await api("/api/deploy", { from: current, sha: candidate });
  $("#state").textContent = `Render đã nhận ${result.deployId}. Đang theo dõi triển khai.`;
  await refresh();
}));
$("#logout").addEventListener("click", () => operate(async () => {
  await api("/api/logout", {});
  clearInterval(polling);
  location.reload();
}));
api("/api/session").then(signIn).catch(() => {});
