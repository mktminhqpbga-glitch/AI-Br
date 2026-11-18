import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openSharedState } from "../shared-state.mjs";
import { createUpdater, updaterConfig } from "../updater-control.mjs";
import { createUpdaterServer } from "../updater-server.mjs";

const from = "a".repeat(40);
const newer = "b".repeat(40);
const next = "c".repeat(40);
const repo = "example/AI-Br";
const serviceId = "srv-gateway";
const webOrigin = "https://updater.example.test";
const password = "fixture-updater-password-not-production";
const renderKey = "fixture-render-key";
const githubKey = "fixture-github-readkey";

function settings(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aibr-updater-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    BRIDGE_UPDATER_DATA_DIR: root, BRIDGE_UPDATER_PUBLIC_URL: webOrigin, BRIDGE_UPDATER_PASSWORD: password,
    BRIDGE_UPDATER_RENDER_KEY: renderKey, BRIDGE_UPDATER_GITHUB_TOKEN: githubKey,
    RENDER_SERVICE_ID: "srv-updater", BRIDGE_UPDATER_TARGET_SERVICE_ID: serviceId,
    BRIDGE_UPDATER_TARGET_REPO: repo,
  };
}

function fixture(t) {
  const config = updaterConfig(settings(t));
  const live = { id: "dep-before", status: "live", commit: { id: from } };
  const state = {
    listed: [], current: live, latest: newer, relation: "ahead", branch: "main",
    autodeploy: "off", dropped: false, posted: [],
  };
  const fetcher = async (address, options) => {
    const url = new URL(address);
    assert.equal(options.redirect, "error");
    const result = (value) => Response.json(value);
    if (url.hostname === "api.github.com") {
      assert.equal(options.headers.Authorization, "Bearer " + githubKey);
      if (url.pathname === "/repos/" + repo + "/commits/main") return result({ sha: state.latest });
      assert.match(url.pathname, new RegExp(`^/repos/${repo}/compare/[a-f0-9]{40}\\.\\.\\.[a-f0-9]{40}$`));
      return result({
        status: state.relation, base_commit: { sha: state.current.commit.id }, merge_base_commit: { sha: state.current.commit.id },
        ahead_by: 1, behind_by: 0, commits: [{ sha: state.latest, commit: { message: "New gateway\nOther info" } }],
      });
    }
    assert.equal(url.hostname, "api.render.com");
    assert.equal(options.headers.Authorization, "Bearer " + renderKey);
    if (url.pathname === "/v1/services/" + serviceId) return result({
      id: serviceId, name: "Gateway", repo: "https://github.com/" + repo, branch: state.branch,
      type: "web_service", autoDeployTrigger: state.autodeploy,
    });
    assert.equal(url.pathname, "/v1/services/" + serviceId + "/deploys");
    if (options.method === "POST") {
      const { commitId } = JSON.parse(options.body);
      state.posted.push(commitId);
      const deploy = { id: "dep-new", status: "created", commit: { id: commitId }, createdAt: new Date().toISOString() };
      state.listed.unshift(deploy);
      if (state.dropped) throw new Error("simulated connection loss");
      return Response.json(deploy, { status: 201 });
    }
    return result((url.searchParams.has("status") ? [state.current] : [...state.listed, state.current]).map((deploy) => ({ deploy })));
  };
  return { controller: createUpdater(config, fetcher), config, fetcher, state };
}

test("updater fences deploys by service, branch, ancestry and exact commit", async (t) => {
  const env = settings(t);
  assert.throws(() => updaterConfig({ ...env, RENDER_SERVICE_ID: serviceId }), /separate updater/);
  const { controller, state } = fixture(t);
  const plan = await controller.preview();
  assert.equal(plan.canDeploy, true);
  assert.equal(plan.current, from);
  assert.equal(plan.candidate, newer);
  assert.deepEqual(plan.commits, [{ sha: newer, title: "New gateway" }]);
  state.latest = next;
  await assert.rejects(controller.deploy(from, newer), { status: 409 });
  state.relation = "diverged";
  assert.equal((await controller.preview()).canDeploy, false);
  await assert.rejects(controller.deploy(from, next), { status: 409 });
  state.relation = "ahead";
  state.branch = "wrong";
  await assert.rejects(controller.preview(), { status: 409 });
  state.branch = "main";
  state.autodeploy = "commit";
  await assert.rejects(controller.preview(), { status: 409 });
  state.autodeploy = "off";
  const submissions = await Promise.allSettled([controller.deploy(from, next), controller.deploy(from, next)]);
  assert.equal(submissions.filter((result) => result.status === "fulfilled").length, 1);
  assert.deepEqual(state.posted, [next]);
  // Render can acknowledge a deploy before returning it from list deploys.
  state.listed.length = 0;
  assert.equal((await controller.preview()).busy, true);
  await assert.rejects(controller.deploy(from, next), { status: 409 });
  assert.deepEqual(state.posted, [next]);
});

test("lost acknowledgment is reconciled on restart without another deploy", async (t) => {
  const { controller, state, config, fetcher } = fixture(t);
  state.dropped = true;
  await assert.rejects(controller.deploy(from, newer), { status: 502 });
  assert.equal(JSON.parse(fs.readFileSync(path.join(config.root, "updater-history.json")))[0].status, "unconfirmed");
  const restored = createUpdater(config, fetcher);
  const pending = await restored.preview();
  assert.equal(pending.busy, true);
  assert.equal(pending.history[0].deployId, "dep-new");
  await assert.rejects(restored.deploy(from, newer), { status: 409 });
  state.current = { ...state.listed[0], status: "live" };
  state.listed.length = 0;
  const live = await restored.preview();
  assert.equal(live.current, newer);
  assert.equal(live.history[0].status, "live");
  assert.equal(live.canDeploy, false);
  assert.deepEqual(state.posted, [newer]);
  assert.doesNotMatch(JSON.stringify(live), /fixture-.*(?:key|password)/);
});

test("PostgreSQL recovers updater history without disk and fences the previous instance", {
  skip: !process.env.BRIDGE_TEST_STATE_DATABASE_URL,
}, async (t) => {
  const { config, fetcher, state } = fixture(t);
  const url = process.env.BRIDGE_TEST_STATE_DATABASE_URL;
  const namespace = "updater:test-" + randomUUID();
  const originalState = await openSharedState(url, namespace);
  t.after(() => originalState.close().catch(() => {}));
  const original = createUpdater(config, fetcher, originalState);
  state.dropped = true;
  await assert.rejects(original.deploy(from, newer), { status: 502 });
  assert.deepEqual(fs.readdirSync(config.root), []);
  fs.rmdirSync(config.root);

  const restoredState = await openSharedState(url, namespace);
  t.after(() => restoredState.close());
  originalState.write("updater-history", []);
  await assert.rejects(originalState.flush(), { code: "STATE_SUPERSEDED" });
  const restored = createUpdater(config, fetcher, restoredState);
  const pending = await restored.preview();
  assert.equal(pending.busy, true);
  assert.equal(pending.history[0].deployId, "dep-new");
  await assert.rejects(restored.deploy(from, newer), { status: 409 });
  assert.deepEqual(state.posted, [newer]);
});

test("separate updater web panel requires its own login and CSRF before calling Render", async (t) => {
  const { controller, state, config } = fixture(t);
  const server = createUpdaterServer(config, controller).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const gatewayHeaders = { Host: new URL(webOrigin).host, "X-Forwarded-Proto": "https" };
  const call = (route, { body, headers = {} } = {}) => new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : undefined;
    const request = http.request({ host: "127.0.0.1", port: server.address().port, path: route,
      method: payload ? "POST" : "GET",
      headers: { ...gatewayHeaders, ...(payload ? {
        Origin: webOrigin, "Content-Type": "application/json", "Content-Length": payload.length,
      } : {}), ...headers },
    }, async (response) => {
      const chunks = [];
      for await (const chunk of response) chunks.push(chunk);
      resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: response.headers }));
    });
    request.on("error", reject);
    request.end(payload);
  });
  assert.equal((await call("/health")).status, 200);
  assert.match(await (await call("/")).text(), /So sánh phiên bản/);
  assert.equal((await call("/api/preview")).status, 401);
  const loggedIn = await call("/api/login", { body: { password } });
  assert.equal(loggedIn.status, 200);
  const cookie = loggedIn.headers.get("set-cookie");
  assert.match(cookie, /HttpOnly; Secure; SameSite=Strict/);
  const creds = { Cookie: cookie.split(";")[0] };
  const { csrf } = await loggedIn.json();
  assert.equal((await call("/api/deploy", { headers: creds, body: { from, sha: newer } })).status, 403);
  const authorized = { ...creds, "X-Updater-CSRF": csrf };
  assert.equal((await call("/api/deploy", { headers: { ...authorized, Origin: "https://another.example" }, body: { from, sha: newer } })).status, 403);
  assert.equal((await call("/api/deploy", { headers: authorized, body: { from, sha: newer } })).status, 202);
  assert.deepEqual(state.posted, [newer]);
});
