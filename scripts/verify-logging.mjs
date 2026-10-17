import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(import.meta.dirname, "..");
const fixturePath = path.join(root, "scripts/fixtures/logging-server.mjs");
const fixtureEnv = {
  EPM_BASE_URL: "https://example.oraclecloud.com", EPM_USERNAME: "fixture-private-service-account",
  EPM_PASSWORD: "fixture-private-password", EPM_APPLICATION: "fixture-private-application",
  HOST: "127.0.0.1", PORT: "0", MCP_ALLOWED_HOSTS: "127.0.0.1", MCP_ALLOWED_ORIGINS: "https://gui.example.com",
  SHUTDOWN_TIMEOUT_MS: "1000",
  EPM_MAX_RETRIES: "0", EPM_MAX_RESPONSE_BYTES: "1024",
};
const secrets = [
  fixtureEnv.EPM_USERNAME, fixtureEnv.EPM_PASSWORD, fixtureEnv.EPM_APPLICATION,
  Buffer.from(`${fixtureEnv.EPM_USERNAME}:${fixtureEnv.EPM_PASSWORD}`).toString("base64"),
  "fixture-bearer-token", "fixture-cookie-value", "fixture-argument-value", "caller-request-id-private",
];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function assertPrivateValuesAbsent(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (const secret of secrets) assert.ok(!text.includes(secret), "A synthetic private value was exposed.");
}

function waitFor(stream, predicate) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timeout); stream.off("data", check); };
    const check = () => { if (predicate()) { cleanup(); resolve(); } };
    const timeout = setTimeout(() => { cleanup(); reject(new Error("Logging fixture timed out.")); }, 10000);
    stream.on("data", check);
    check();
  });
}

async function startHttpFixture(t) {
  const child = spawn(process.execPath, [fixturePath], {
    cwd: root, env: { ...process.env, ...fixtureEnv }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const exited = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
  });
  const records = () => stderr.split("\n").slice(0, -1).map((line) => JSON.parse(line));
  await waitFor(child.stderr, () => records().some(({ event }) => event === "server.listening"));
  return {
    baseUrl: `http://127.0.0.1:${records().find(({ event }) => event === "server.listening").port}`,
    records,
    assertSafe: () => { assert.equal(stdout, ""); assertPrivateValuesAbsent(stderr); },
    waitForRecord: (event, requestId) => waitFor(child.stderr, () => records().some((record) => record.event === event && record.requestId === requestId)),
  };
}

function request(baseUrl, route, { method = "GET", body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${baseUrl}${route}`, {
      method, agent: false,
      headers: { Accept: "application/json, text/event-stream", "Content-Type": "application/json", ...headers },
    }, (res) => {
      let body = "";
      res.setEncoding("utf8").on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
      res.on("error", reject);
    });
    req.setTimeout(5000, () => req.destroy(new Error("Logging HTTP request timed out.")));
    req.on("error", reject);
    req.end(body);
  });
}

function rpcResult(response) {
  if (response.headers["content-type"].includes("text/event-stream")) {
    const messages = response.body.split(/\r?\n/).filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)));
    return messages.find((message) => message.result)?.result;
  }
  return JSON.parse(response.body).result;
}

test("concurrent HTTP tool errors correlate with access logs without exposing private values", { timeout: 20000 }, async (t) => {
  const fixture = await startHttpFixture(t);
  const scenarios = [
    ["http-401", "EPM_HTTP_ERROR"], ["http-403", "EPM_HTTP_ERROR"], ["http-404", "EPM_HTTP_ERROR"],
    ["http-429", "EPM_HTTP_ERROR"], ["http-500", "EPM_HTTP_ERROR"], ["network-error", "EPM_NETWORK_ERROR"],
    ["invalid-json", "EPM_RESPONSE_FORMAT"], ["invalid-format", "EPM_RESPONSE_FORMAT"], ["timeout", "EPM_TIMEOUT"],
    ["oversized", "EPM_RESPONSE_TOO_LARGE"],
  ];
  const responses = await Promise.all(scenarios.map(async ([scenario, errorCode], id) => {
    const response = await request(fixture.baseUrl, `/mcp?token=${fixtureEnv.EPM_PASSWORD}`, {
      method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: {
        name: "list-epm-plan-types", arguments: { application: scenario },
      } }),
      headers: {
        Origin: "https://gui.example.com", Authorization: "Bearer fixture-bearer-token",
        Cookie: "session=fixture-cookie-value", "X-Request-Id": "caller-request-id-private",
        "MCP-Protocol-Version": "2025-11-25",
      },
    });
    assert.equal(response.status, 200);
    const result = rpcResult(response);
    assert.ok(result.isError);
    const requestId = response.headers["x-request-id"];
    assert.match(requestId, uuid);
    assert.equal(result._meta.requestId, requestId);
    assert.equal(result._meta.errorCode, errorCode);
    assert.ok(result.content[0].text.includes(requestId));
    assertPrivateValuesAbsent(response.body);
    await fixture.waitForRecord("http.request.completed", requestId);
    const toolLog = fixture.records().find((record) => record.event === "mcp.tool.failed" && record.requestId === requestId);
    assert.equal(toolLog.errorCode, errorCode);
    assert.equal(toolLog.level, "error");
    const accessLog = fixture.records().find((record) => record.event === "http.request.completed" && record.requestId === requestId);
    assert.equal(accessLog.route, "/mcp");
    assert.equal(accessLog.status, 200);
    assert.ok(accessLog.durationMs >= 0);
    return requestId;
  }));
  assert.equal(new Set(responses).size, scenarios.length);
  fixture.assertSafe();
});

test("HTTP parser errors and early rejections have request IDs and sanitized JSON logs", { timeout: 15000 }, async (t) => {
  const fixture = await startHttpFixture(t);
  const responses = [
    await request(fixture.baseUrl, "/mcp", { method: "POST", body: `{"password":"${fixtureEnv.EPM_PASSWORD}"` }),
    await request(fixture.baseUrl, "/health", { headers: { Origin: "https://unapproved.test" } }),
    await request(fixture.baseUrl, "/health", { headers: { Host: "unapproved.test" } }),
    await request(fixture.baseUrl, "/health", { method: "OPTIONS", headers: {
      Origin: "https://gui.example.com", "Access-Control-Request-Method": "POST",
    } }),
  ];
  assert.deepEqual(responses.map(({ status }) => status), [400, 403, 403, 204]);
  assert.deepEqual(JSON.parse(responses[0].body), { error: "Invalid JSON request body." });
  await fixture.waitForRecord("http.request.failed", responses[0].headers["x-request-id"]);
  for (const response of responses) {
    const id = response.headers["x-request-id"];
    assert.match(id, uuid);
    assertPrivateValuesAbsent(response.body);
    await fixture.waitForRecord("http.request.completed", id);
  }
  fixture.assertSafe();
});

test("successful responses and application-summary compatibility remain intact", { timeout: 15000 }, async (t) => {
  const fixture = await startHttpFixture(t);
  for (const [tool, application, expected] of [
    ["list-epm-plan-types", "success", { items: [{ name: "Safe result" }] }],
    ["get-epm-application-summary", "summary-fallback", "Safe Markdown summary"],
  ]) {
    const response = await request(fixture.baseUrl, "/mcp", { method: "POST", body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: { application } },
    }) });
    const result = rpcResult(response);
    assert.ok(!result.isError);
    assert.deepEqual(result.structuredContent.data, expected);
    assert.equal(result._meta.requestId, response.headers["x-request-id"]);
    await fixture.waitForRecord("mcp.tool.completed", result._meta.requestId);
  }
  fixture.assertSafe();
});

test("stdio keeps protocol output clean and masks every username format", { timeout: 15000 }, async () => {
  for (const [username, masked] of [
    ["service-account", "se****"], ["service@example.com", "se****"], ["DOMAIN\\service", "DO****"],
    ["a", "****"], ["ab", "****"], ["😀account", "😀a****"],
  ]) {
    const client = new Client({ name: "logging-stdio-verifier", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath, args: [fixturePath, "--stdio"], cwd: root,
      env: { ...fixtureEnv, EPM_USERNAME: username }, stderr: "pipe",
    });
    let diagnostics = "";
    transport.stderr.on("data", (chunk) => { diagnostics += chunk.toString(); });
    try {
      await client.connect(transport);
      const status = await client.callTool({ name: "get-epm-connection-status", arguments: {} });
      assert.equal(status.structuredContent.connection.username, masked);
      assert.match(status._meta.requestId, uuid);
      const failed = await client.callTool({ name: "list-epm-plan-types", arguments: { application: "http-401" } });
      assert.ok(failed.isError);
      assert.match(failed._meta.requestId, uuid);
      assert.notEqual(failed._meta.requestId, status._meta.requestId);
      assert.equal(failed._meta.errorCode, "EPM_HTTP_ERROR");
      assertPrivateValuesAbsent(failed);
    } finally {
      await client.close();
    }
    const records = diagnostics.trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(records.some(({ event }) => event === "mcp.tool.failed"));
    assertPrivateValuesAbsent(diagnostics);
  }
});
