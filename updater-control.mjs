import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const commitSha = /^[a-f0-9]{40}$/;
const renderServiceId = /^srv-[a-z0-9]+$/;
const deployId = /^dep-[a-z0-9]+$/;
const finished = new Set(["live", "deactivated", "build_failed", "pre_deploy_failed", "update_failed", "canceled"]);

export class UpdaterError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function httpsOrigin(value) {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && (value === url.origin || value === url.origin + "/")) return url.origin;
  } catch {}
  throw new UpdaterError(422, "Dùng địa chỉ HTTPS gốc của dịch vụ.");
}

function repoFromRender(value) {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value);
    if (url.origin !== "https://github.com" || url.username || url.password || url.search || url.hash) return "";
    return url.pathname.replace(/^\//, "").replace(/\/$/, "").replace(/\.git$/, "").toLowerCase();
  } catch { return ""; }
}

export function updaterConfig(env) {
  const repo = env.BRIDGE_UPDATER_TARGET_REPO ?? "mktminhqpbga-glitch/AI-Br";
  const branch = env.BRIDGE_UPDATER_TARGET_BRANCH ?? "main";
  const ownId = env.RENDER_SERVICE_ID;
  const serviceId = env.BRIDGE_UPDATER_TARGET_SERVICE_ID;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || repo.split("/").some((part) => part === "." || part === "..")
    || !/^[\w./-]{1,150}$/.test(branch) || branch.split("/").some((part) => !part || part === "." || part === "..")
    || !renderServiceId.test(ownId ?? "") || !renderServiceId.test(serviceId ?? "") || serviceId === ownId
    || !env.BRIDGE_UPDATER_RENDER_KEY || (env.BRIDGE_UPDATER_PASSWORD?.length ?? 0) < 24
    || !env.BRIDGE_UPDATER_DATA_DIR) {
    throw new Error("Configure a separate updater, a target service, storage and administrator credentials.");
  }
  return {
    origin: httpsOrigin(env.BRIDGE_UPDATER_PUBLIC_URL), root: path.resolve(env.BRIDGE_UPDATER_DATA_DIR),
    password: env.BRIDGE_UPDATER_PASSWORD, serviceId, repo, branch,
    renderKey: env.BRIDGE_UPDATER_RENDER_KEY, githubToken: env.BRIDGE_UPDATER_GITHUB_TOKEN,
  };
}

function deployInfo(deploy) {
  return {
    id: deploy.id, status: deploy.status,
    sha: commitSha.test(deploy.commit?.id ?? "") ? deploy.commit.id : null,
    createdAt: typeof deploy.createdAt === "string" ? deploy.createdAt : null,
  };
}

export function createUpdater(config, fetcher = fetch, state) {
  fs.mkdirSync(config.root, { recursive: true, mode: 0o700 });
  const file = path.join(config.root, "updater-history.json");
  let history = (state ? state.initial.get("updater-history") : fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : undefined) ?? [];
  if (!Array.isArray(history) || history.some((entry) => entry.serviceId !== config.serviceId
    || entry.repo !== config.repo || entry.branch !== config.branch)) {
    throw new Error("Updater history belongs to a different Git target or Render service.");
  }
  let submitting = false;

  async function save(entry) {
    const next = [entry, ...history.filter((old) => old.id !== entry.id)].slice(0, 50);
    if (state) {
      state.write("updater-history", next);
      history = next;
      return state.flush();
    }
    const temp = file + "." + randomUUID() + ".tmp";
    try {
      fs.writeFileSync(temp, JSON.stringify(next), { mode: 0o600, flush: true, flag: "wx" });
      fs.renameSync(temp, file);
      if (process.platform !== "win32") {
        const directory = fs.openSync(path.dirname(file), "r");
        try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
      }
      history = next;
    } finally { fs.rmSync(temp, { force: true }); }
  }

  async function upstream(origin, pathname, token, options = {}) {
    let response;
    try {
      response = await fetcher(origin + pathname, {
        method: options.method ?? "GET", redirect: "error", signal: AbortSignal.timeout(12_000),
        headers: {
          Accept: "application/json", "User-Agent": "AI-Br-Updater",
          ...(token ? { Authorization: "Bearer " + token } : {}),
          ...(options.body ? { "Content-Type": "application/json" } : {}),
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
      });
    } catch {
      throw new UpdaterError(502, "Không kết nối được API GitHub hoặc Render.");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      const failure = new UpdaterError(502, `API ${origin.includes("github") ? "GitHub" : "Render"} trả HTTP ${response.status}.`);
      failure.upstreamStatus = response.status;
      throw failure;
    }
    try { return await response.json(); }
    catch { throw new UpdaterError(502, "API cập nhật trả nội dung chưa xác minh được."); }
  }
  const renderPath = "/v1/services/" + config.serviceId;
  const render = (suffix, options) => upstream("https://api.render.com", renderPath + suffix, config.renderKey, options);
  const githubRoot = "/repos/" + config.repo.split("/").map(encodeURIComponent).join("/");
  const github = (suffix) => upstream("https://api.github.com", githubRoot + suffix, config.githubToken);

  function checkService(service) {
    if (service?.id !== config.serviceId || service.type !== "web_service" || service.branch !== config.branch
      || repoFromRender(service.repo) !== config.repo.toLowerCase() || service.suspended === "suspended") {
      throw new UpdaterError(409, "Dịch vụ Render không khớp repo, nhánh hoặc ID của gateway đã cấu hình.");
    }
    if (!(service.autoDeployTrigger === "off" || service.autoDeployTrigger == null && service.autoDeploy === "no")) {
      throw new UpdaterError(409, "Tắt Auto-Deploy của gateway để chỉ triển khai commit đã xem trước.");
    }
  }

  async function refreshHistory(deploys) {
    const entry = history[0];
    if (!entry) return;
    const found = entry.deployId
      ? deploys.find((deploy) => deploy.id === entry.deployId)
      : deploys.find((deploy) => deploy.sha === entry.sha && Date.parse(deploy.createdAt) >= Math.floor(entry.startedAt / 1000) * 1000);
    if (found && found.sha === entry.sha && (entry.deployId !== found.id || entry.status !== found.status)) {
      await save({ ...entry, deployId: found.id, status: found.status });
    }
  }

  async function preview() {
    const [service, listed, liveList, latest] = await Promise.all([
      render(""), render("/deploys?limit=20"), render("/deploys?status=live&limit=1"),
      github("/commits/" + encodeURIComponent(config.branch)),
    ]);
    checkService(service);
    if (!Array.isArray(listed) || !Array.isArray(liveList) || !commitSha.test(latest?.sha ?? "")) {
      throw new UpdaterError(502, "Không xác minh được trạng thái phát hành.");
    }
    const deploys = listed.map((entry) => entry?.deploy)
      .filter((entry) => deployId.test(entry?.id ?? "") && typeof entry.status === "string").map(deployInfo);
    if (deploys.length !== listed.length) throw new UpdaterError(502, "Lịch sử Render trả dữ liệu không hợp lệ.");
    const live = liveList[0]?.deploy;
    const current = live?.status === "live" && commitSha.test(live.commit?.id ?? "") ? live.commit.id : null;
    if (!submitting) await refreshHistory(deploys);
    const lastAttempt = history[0];
    const pending = lastAttempt && lastAttempt.status !== "rejected" && !finished.has(lastAttempt.status);
    const busy = Boolean(pending || deploys.some((deploy) => !finished.has(deploy.status)));
    const candidate = latest.sha;
    const comparison = current && current !== candidate ? await github(`/compare/${current}...${candidate}?per_page=20`) : null;
    const relation = current === candidate ? "identical" : comparison?.status ?? "no_live";
    const verifiedAdvance = relation === "ahead" && comparison?.base_commit?.sha === current
      && comparison?.merge_base_commit?.sha === current && comparison.ahead_by > 0 && comparison.behind_by === 0;
    return {
      repo: config.repo, branch: config.branch, serviceName: service.name, current, candidate, relation, busy,
      canDeploy: Boolean(verifiedAdvance && !busy), ahead: comparison?.ahead_by ?? 0,
      compareUrl: current ? `https://github.com/${config.repo}/compare/${current}...${candidate}` : null,
      commits: Array.isArray(comparison?.commits) ? comparison.commits.slice(0, 20).map((commit) => ({
        sha: commitSha.test(commit.sha ?? "") ? commit.sha : "", title: String(commit.commit?.message ?? "").split("\n")[0].slice(0, 160),
      })) : [],
      history: history.map(({ from, sha, status, deployId, startedAt }) => ({ from, sha, status, deployId, startedAt })),
    };
  }

  async function deploy(from, sha) {
    if (typeof from !== "string" || typeof sha !== "string" || !commitSha.test(from) || !commitSha.test(sha)) {
      throw new UpdaterError(422, "Hãy kiểm tra lại hai commit trước khi triển khai.");
    }
    if (submitting) throw new UpdaterError(409, "Đang gửi yêu cầu triển khai.");
    // Refresh pending attempts before locking. Once the lock is held, no
    // second request can enter or modify the in-flight entry while awaiting Render.
    if (["submitting", "unconfirmed"].includes(history[0]?.status)) {
      await preview();
      if (submitting || ["submitting", "unconfirmed"].includes(history[0]?.status))
        throw new UpdaterError(409, "Yêu cầu trước chưa xác minh được. Kiểm tra trạng thái trước khi triển khai tiếp.");
    }
    submitting = true;
    try {
      const plan = await preview();
      if (!plan.canDeploy || plan.current !== from || plan.candidate !== sha) {
        throw new UpdaterError(409, "Commit hoặc trạng thái Render đã đổi. Hãy kiểm tra lại trước khi triển khai.");
      }
      const entry = {
        id: randomUUID(), serviceId: config.serviceId, repo: config.repo, branch: config.branch,
        startedAt: Date.now(), from, sha, status: "submitting",
      };
      await save(entry);
      try {
        const result = await render("/deploys", { method: "POST", body: { commitId: sha } });
        if (!deployId.test(result?.id ?? "") || result.commit?.id && result.commit.id !== sha) {
          throw new UpdaterError(502, "Render chưa xác nhận đúng yêu cầu triển khai.");
        }
        await save({ ...entry, deployId: result.id, status: result.status ?? "created" });
        return { deployId: result.id, sha, status: result.status ?? "created" };
      } catch (error) {
        const rejected = [400, 401, 403, 404, 422].includes(error.upstreamStatus);
        await save({ ...entry, status: rejected ? "rejected" : "unconfirmed" });
        if (rejected) throw error;
        throw new UpdaterError(502, "Chưa xác minh Render đã nhận deploy. Hãy kiểm tra trạng thái, tránh gửi lại.");
      }
    } finally { submitting = false; }
  }

  return { preview, deploy };
}
