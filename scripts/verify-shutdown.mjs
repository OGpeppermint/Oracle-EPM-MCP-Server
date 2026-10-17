import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { manageHttpShutdown } from "../dist/shutdown.js";

const root = path.resolve(import.meta.dirname, "..");

function waitFor(emitter, event, predicate) {
  return new Promise((resolve, reject) => {
    const finish = () => { clearTimeout(timeout); emitter.off(event, check); };
    const check = () => { if (predicate()) { finish(); resolve(); } };
    const timeout = setTimeout(() => { finish(); reject(new Error(`Timed out waiting for ${event}.`)); }, 10000);
    emitter.on(event, check);
    check();
  });
}

async function startFixture(t, shutdownTimeoutMs = 2000) {
  const child = spawn(process.execPath, [path.join(root, "scripts/fixtures/shutdown-server.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      EPM_BASE_URL: "https://example.oraclecloud.com", EPM_USERNAME: "verification@example.com",
      EPM_PASSWORD: "verification-only-password", EPM_APPLICATION: "Verification",
      HOST: "127.0.0.1", PORT: "0", MCP_ALLOWED_HOSTS: "127.0.0.1", MCP_ALLOWED_ORIGINS: "",
      SHUTDOWN_TIMEOUT_MS: String(shutdownTimeoutMs),
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let output = "";
  let diagnostics = "";
  const messages = [];
  child.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { diagnostics += chunk; });
  child.on("message", (message) => messages.push(message));
  const exited = once(child, "exit");
  // Register cleanup before awaiting startup so a failed assertion cannot leave a server running.
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
  });
  await waitFor(child.stdout, "data", () => /listening on http:\/\/127\.0\.0\.1:\d+\/mcp/.test(output));
  const baseUrl = output.match(/listening on (http:\/\/127\.0\.0\.1:\d+)\/mcp/)[1];

  async function signal(signal, options = {}) {
    const prepared = waitFor(child, "message", () => messages.some(({ type }) => type === "prepared"));
    child.send({ type: "prepare-shutdown", signal, emitSignal: process.platform === "win32", ...options });
    await prepared;
    if (process.platform !== "win32") {
      child.kill(signal);
      if (options.repeat) child.kill(signal === "SIGTERM" ? "SIGINT" : "SIGTERM");
    }
  }

  return {
    child, baseUrl, signal,
    oracleStarted: () => waitFor(child, "message", () => messages.some(({ type }) => type === "oracle-started")),
    draining: () => waitFor(child.stderr, "data", () => diagnostics.includes("draining active connections")),
    diagnostics: () => diagnostics,
    exit: async () => {
      await waitFor(child, "exit", () => child.exitCode !== null || child.signalCode !== null);
      return exited;
    },
  };
}

function health(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${url}/health`, { agent: false }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.setTimeout(1000, () => req.destroy(new Error("Health request timed out.")));
    req.on("error", reject);
  });
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  test(`idle HTTP server exits cleanly on ${signal}`, { timeout: 15000 }, async (t) => {
    const fixture = await startFixture(t);
    assert.equal(await health(fixture.baseUrl), 200);
    await fixture.signal(signal);
    assert.deepEqual(await fixture.exit(), [0, null]);
    assert.match(fixture.diagnostics(), /HTTP shutdown complete/);
    await assert.rejects(health(fixture.baseUrl));
  });
}

test("active MCP call completes while new connections are refused and repeated signals are ignored", { timeout: 15000 }, async (t) => {
  const fixture = await startFixture(t);
  const client = new Client({ name: "shutdown-verifier", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(`${fixture.baseUrl}/mcp`)));
  const result = client.callTool({ name: "get-epm-api-versions", arguments: {} }).then(
    (value) => ({ value }), (error) => ({ error }),
  );
  await fixture.oracleStarted();
  await fixture.signal("SIGTERM", { releaseAfterMs: 400, repeat: true });
  await fixture.draining();
  await assert.rejects(health(fixture.baseUrl));
  const completed = await result;
  assert.equal(completed.error, undefined);
  assert.ok(!completed.value.isError);
  assert.deepEqual(completed.value.structuredContent.data, { items: [{ version: "v3" }] });
  const exit = await fixture.exit();
  assert.deepEqual(exit, [0, null], fixture.diagnostics());
  assert.equal((fixture.diagnostics().match(/Received SIG/g) ?? []).length, 1);
});

test("an unfinished MCP request is terminated at the shutdown deadline", { timeout: 15000 }, async (t) => {
  const fixture = await startFixture(t, 200);
  const client = new Client({ name: "shutdown-deadline-verifier", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(`${fixture.baseUrl}/mcp`)));
  const request = client.callTool({ name: "get-epm-api-versions", arguments: {} }).catch((error) => error);
  await fixture.oracleStarted();
  await fixture.signal("SIGTERM");
  assert.deepEqual(await fixture.exit(), [1, null]);
  assert.match(fixture.diagnostics(), /Shutdown deadline exceeded/);
  await client.close();
  assert.ok(await request instanceof Error);
});

test("an abandoned Oracle read is cancelled after HTTP requests drain", { timeout: 15000 }, async (t) => {
  const fixture = await startFixture(t);
  const client = new Client({ name: "shutdown-abandoned-request-verifier", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(`${fixture.baseUrl}/mcp`)));
  const request = client.callTool({ name: "get-epm-api-versions", arguments: {} }).catch((error) => error);
  await fixture.oracleStarted();
  await client.close();
  assert.ok(await request instanceof Error);
  await fixture.signal("SIGTERM");
  const exit = await fixture.exit();
  assert.deepEqual(exit, [0, null], fixture.diagnostics());
  assert.match(fixture.diagnostics(), /HTTP shutdown complete/);
});

test("shutdown awaits resource cleanup and closes each resource once", { timeout: 5000 }, async () => {
  const listener = http.createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const lifecycle = manageHttpShutdown(listener, 2000);
  let calls = 0;
  let finishCleanup;
  let cleanupStarted;
  const started = new Promise((resolve) => { cleanupStarted = resolve; });
  const cleanup = new Promise((resolve) => { finishCleanup = resolve; });
  const release = lifecycle.track(async () => { calls++; cleanupStarted(); await cleanup; });
  let complete = false;
  const shutdown = lifecycle.shutdown("SIGTERM");
  assert.equal(shutdown, lifecycle.shutdown("SIGINT"));
  void shutdown.then(() => { complete = true; });
  await started;
  const duplicateRelease = release();
  assert.equal(complete, false);
  finishCleanup();
  await Promise.all([shutdown, duplicateRelease]);
  assert.equal(calls, 1);
});
