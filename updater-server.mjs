import http from "node:http";
import fs from "node:fs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createUpdater, UpdaterError, updaterConfig } from "./updater-control.mjs";

const assets = new Map([
  ["/", ["./updater-ui/index.html", "text/html"]],
  ["/updater.js", ["./updater-ui/updater.js", "text/javascript"]],
  ["/dashboard.css", ["./cloud-ui/dashboard.css", "text/css"]],
]);
const digest = (value) => createHash("sha256").update(value).digest();
const credential = () => randomBytes(32).toString("base64url");
const cookie = "__Host-aibr-updater";

function json(response, status, value) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

async function body(request) {
  if (request.headers["content-type"]?.split(";")[0] !== "application/json") throw new UpdaterError(415, "Yêu cầu phải dùng JSON.");
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 4096) throw new UpdaterError(413, "Dữ liệu gửi quá lớn.");
    chunks.push(chunk);
  }
  try {
    const result = JSON.parse(Buffer.concat(chunks));
    if (result && typeof result === "object" && !Array.isArray(result)) return result;
  } catch {}
  throw new UpdaterError(400, "JSON không hợp lệ.");
}

export function createUpdaterServer(config, updater = createUpdater(config)) {
  const sessions = new Map();
  const passwordHash = digest(config.password);
  const expectedHost = new URL(config.origin).host;
  let loginCount = 0;
  let windowEnd = 0;
  function authenticate(request, response) {
    const value = request.headers.cookie?.match(/(?:^|;\s*)__Host-aibr-updater=([\w-]{43})(?:;|$)/)?.[1];
    const key = value && digest(value).toString("hex");
    const session = key && sessions.get(key);
    if (!session || session.expires <= Date.now()) throw new UpdaterError(401, "Hãy đăng nhập mục cập nhật.");
    if (request.method === "POST" && request.headers["x-updater-csrf"] !== session.csrf) {
      throw new UpdaterError(403, "Phiên cập nhật không hợp lệ. Hãy đăng nhập lại.");
    }
    if (request.url === "/api/logout") {
      sessions.delete(key);
      response.setHeader("Set-Cookie", cookie + "=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0");
    }
    return session;
  }
  return http.createServer(async (request, response) => {
    try {
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("Referrer-Policy", "no-referrer");
      response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      const { method, url } = request;
      if (method === "GET" && url === "/health") return json(response, 200, { ok: true });
      if (request.headers.host !== expectedHost || request.headers["x-forwarded-proto"] !== "https") {
        throw new UpdaterError(421, "Dùng địa chỉ HTTPS của dịch vụ cập nhật.");
      }
      if (method === "POST" && request.headers.origin !== config.origin) throw new UpdaterError(403, "Origin không hợp lệ.");
      const asset = method === "GET" && assets.get(url);
      if (asset) {
        const content = fs.readFileSync(new URL(asset[0], import.meta.url));
        response.writeHead(200, { "Content-Type": asset[1] + "; charset=utf-8" });
        return response.end(content);
      }
      if (method === "POST" && url === "/api/login") {
        const now = Date.now();
        if (windowEnd <= now) { windowEnd = now + 60_000; loginCount = 0; }
        if (++loginCount > 12) throw new UpdaterError(429, "Thử lại sau một phút.");
        const { password } = await body(request);
        if (typeof password !== "string" || !timingSafeEqual(digest(password), passwordHash)) {
          throw new UpdaterError(401, "Mật khẩu cập nhật không hợp lệ.");
        }
        for (const [key, session] of sessions) if (session.expires <= now) sessions.delete(key);
        if (sessions.size >= 64) sessions.delete(sessions.keys().next().value);
        const token = credential();
        const csrf = credential();
        sessions.set(digest(token).toString("hex"), { csrf, expires: now + 4 * 3_600_000 });
        response.setHeader("Set-Cookie", `${cookie}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=14400`);
        return json(response, 200, { csrf });
      }
      const session = authenticate(request, response);
      if (method === "GET" && url === "/api/session") return json(response, 200, { csrf: session.csrf });
      if (method === "GET" && url === "/api/preview") return json(response, 200, await updater.preview());
      if (method === "POST" && url === "/api/deploy") {
        const { from, sha } = await body(request);
        return json(response, 202, await updater.deploy(from, sha));
      }
      if (method === "POST" && url === "/api/logout") return json(response, 200, { ok: true });
      throw new UpdaterError(404, "Không tìm thấy.");
    } catch (error) {
      if (!response.headersSent) json(response, error.status ?? 500, { error: { message: error instanceof UpdaterError ? error.message : "Dịch vụ cập nhật gặp lỗi." } });
      else response.end();
    }
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const config = updaterConfig(process.env);
    if (process.getuid?.() === 0 && config.root === "/var/data/ai-bridge-updater") {
      fs.mkdirSync(config.root, { mode: 0o700, recursive: true });
      fs.chownSync(config.root, 1000, 1000);
      process.setgroups([]);
      process.setgid(1000);
      process.setuid(1000);
    }
    const port = Number(process.env.PORT ?? 10000);
    createUpdaterServer(config).listen(port, "0.0.0.0", () => console.log("[ai-bridge-updater] Listening on port " + port));
  } catch {
    console.error("[ai-bridge-updater] Check updater credentials, target service and data directory.");
    process.exitCode = 1;
  }
}
