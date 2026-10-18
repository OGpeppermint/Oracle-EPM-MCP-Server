import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const root = path.resolve(import.meta.dirname, "..");
const browserOrigins = ["https://command-center.example.com", "http://localhost:5173"];
const protocolVersion = "2025-11-25";
const fixtureEnv = {
  EPM_BASE_URL: "https://example.oraclecloud.com", EPM_USERNAME: "http-private-service-account",
  EPM_PASSWORD: "http-private-password", EPM_APPLICATION: "Verification",
  HOST: "127.0.0.1", PORT: "0", MCP_ALLOWED_HOSTS: "127.0.0.1, mcp.test",
  SHUTDOWN_TIMEOUT_MS: "2000", EPM_REQUEST_TIMEOUT_MS: "1000", EPM_MAX_RETRIES: "0", EPM_MAX_RESPONSE_BYTES: "4096",
};
const secrets = [
  fixtureEnv.EPM_USERNAME, fixtureEnv.EPM_PASSWORD,
  Buffer.from(`${fixtureEnv.EPM_USERNAME}:${fixtureEnv.EPM_PASSWORD}`).toString("base64"),
  "http-private-bearer", "http-private-cookie", "http-private-query", "http-private-json",
];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const message = (id, method = "tools/list", params) => ({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
const initialization = (id, version = protocolVersion) => message(id, "initialize", {
  protocolVersion: version, capabilities: {}, clientInfo: { name: "http-protocol-verifier", version: "1.0.0" },
});

function assertSafe(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (const secret of secrets) assert.ok(!text.includes(secret), "An HTTP response or diagnostic exposed a synthetic private value.");
  assert.doesNotMatch(text, /\n\s+at .+\.(?:js|ts):\d+/);
}

async function startFixture(t, allowedOrigins) {
  const child = spawn(process.execPath, [path.join(root, "scripts/fixtures/http-server.mjs")], {
    cwd: root, env: { ...process.env, ...fixtureEnv, MCP_ALLOWED_ORIGINS: allowedOrigins.join(",") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const closed = new Promise((resolve) => child.once("close", resolve));
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  // Install cleanup before waiting for readiness so startup failures cannot leak a child.
  t.after(async () => {
    if (child.pid && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
    assert.equal(stdout, "", "HTTP startup must not write to stdout.");
    assertSafe(stderr);
    const records = stderr.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.ok(!records.some(({ event }) => event === "fixture.oracle.unexpected"), "Protocol tests attempted an Oracle call.");
  });
  const baseUrl = await new Promise((resolve, reject) => {
    const finish = () => {
      clearTimeout(timeout);
      child.stderr.off("data", ready);
      child.off("error", failed);
      child.off("exit", exited);
    };
    const ready = () => {
      try {
        for (const line of stderr.split("\n").slice(0, -1)) {
          const record = JSON.parse(line);
          if (record.event === "server.listening") { finish(); resolve(`http://127.0.0.1:${record.port}`); return; }
        }
      } catch (error) { finish(); reject(error); }
    };
    const failed = (error) => { finish(); reject(error); };
    const exited = () => { finish(); reject(new Error("HTTP verification server exited before readiness.")); };
    const timeout = setTimeout(() => { finish(); reject(new Error("HTTP verification server startup timed out.")); }, 10000);
    child.stderr.on("data", ready);
    child.once("error", failed);
    child.once("exit", exited);
    ready();
  });

  const responseIds = new Set();
  function checkResponse(response) {
    const requestId = response.headers["x-request-id"];
    assert.match(requestId, uuid);
    assert.ok(!responseIds.has(requestId), "Separate HTTP responses must have distinct request IDs.");
    responseIds.add(requestId);
    assert.equal(response.headers["mcp-session-id"], undefined, "Stateless responses must not issue a session ID.");
    assertSafe(response.body);
    return response;
  }

  function request(route, { hostname = "mcp.test", method = "GET", headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request(`${baseUrl}${route}`, {
        method, agent: false,
        headers: Object.fromEntries(Object.entries({ Host: hostname, ...headers }).filter(([, value]) => value !== undefined)),
      }, (res) => {
        let body = "";
        res.setEncoding("utf8").on("data", (chunk) => { body += chunk; });
        res.on("end", () => {
          try { resolve(checkResponse({ status: res.statusCode, headers: res.headers, body })); }
          catch (error) { reject(error); }
        });
        res.on("error", reject);
      });
      req.setTimeout(5000, () => req.destroy(new Error("HTTP verification request timed out.")));
      req.on("error", reject);
      req.end(body);
    });
  }

  function post(value, options = {}) {
    return request("/mcp", {
      ...options, method: "POST", body: JSON.stringify(value),
      headers: {
        Accept: "application/json, text/event-stream", "Content-Type": "application/json",
        "MCP-Protocol-Version": protocolVersion, ...options.headers,
      },
    });
  }

  async function openStream() {
    // GET intentionally remains open: inspect its headers, then cancel instead of waiting for EOF.
    await new Promise((resolve, reject) => {
      let receivedHeaders = false;
      const req = http.get(`${baseUrl}/mcp`, {
        agent: false, headers: { Host: "mcp.test", Accept: "text/event-stream", "MCP-Protocol-Version": protocolVersion },
      }, (res) => {
        receivedHeaders = true;
        try {
          assert.equal(res.statusCode, 200);
          assert.match(res.headers["content-type"], /^text\/event-stream\b/);
          assert.match(res.headers["cache-control"], /no-cache/);
          checkResponse({ headers: res.headers, body: "" });
          res.once("close", resolve);
        } catch (error) { reject(error); }
        finally { res.destroy(); req.destroy(); }
      });
      req.setTimeout(5000, () => req.destroy(new Error("GET stream headers timed out.")));
      req.on("error", (error) => { if (!receivedHeaders) reject(error); });
    });
  }

  return { baseUrl, request, post, openStream };
}

function jsonError(response, status, code) {
  assert.equal(response.status, status);
  assert.match(response.headers["content-type"], /^application\/json\b/);
  const body = JSON.parse(response.body);
  assert.equal(body.jsonrpc, "2.0");
  assert.equal(body.id, null);
  assert.equal(body.error.code, code);
  assert.equal(typeof body.error.message, "string");
  assert.equal(body.result, undefined);
  return body;
}

function rpcResponse(response, id) {
  assert.equal(response.status, 200);
  assert.match(response.headers["content-type"], /^text\/event-stream\b/);
  const messages = response.body.split(/\r?\n\r?\n/).flatMap((event) => {
    const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    return data ? [JSON.parse(data)] : [];
  });
  for (const value of messages) assert.equal(value.jsonrpc, "2.0");
  const replies = messages.filter((value) => Object.hasOwn(value, "result") || Object.hasOwn(value, "error"));
  assert.equal(replies.length, 1, "A request must receive exactly one terminal JSON-RPC response.");
  assert.equal(replies[0].id, id);
  assert.notEqual(Object.hasOwn(replies[0], "result"), Object.hasOwn(replies[0], "error"));
  return replies[0];
}

// Contract reference: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
for (const allowedOrigins of [browserOrigins, []]) {
  const profile = allowedOrigins.length ? "explicit browser origins" : "no browser origins";
  test(`HTTP transport (${profile})`, { timeout: 45000 }, async (t) => {
    const { baseUrl, request, post, openStream } = await startFixture(t, allowedOrigins);

    await t.test("health, hostname restrictions, and browser-origin rejection", async () => {
      const health = await request("/health");
      assert.equal(health.status, 200);
      assert.deepEqual(JSON.parse(health.body), { status: "ok" });
      assert.equal(health.headers["access-control-allow-origin"], undefined);
      for (const route of ["/health", "/mcp"]) {
        assert.equal((await request(route, { hostname: "unapproved.test" })).status, 403);
      }
      for (const origin of ["https://unapproved.test", "https://command-center.example.com.evil.test", "http://localhost:5174", "null"]) {
        for (const method of ["POST", "OPTIONS"]) {
          const rejected = await request("/mcp", {
            method, headers: { Origin: origin, "Content-Type": "application/json", "Access-Control-Request-Method": "POST" },
            body: method === "POST" ? JSON.stringify(message(1)) : undefined,
          });
          assert.equal(rejected.status, 403);
          assert.equal(rejected.headers["access-control-allow-origin"], undefined);
          assert.deepEqual(JSON.parse(rejected.body), { error: "Request origin is not allowed." });
          assert.match(rejected.headers.vary, /Origin/i);
        }
      }
    });

    await t.test("CORS preflight and exposed MCP headers", async () => {
      for (const origin of browserOrigins) {
        const response = await request("/health", { headers: { Origin: origin } });
        const preflight = await request("/mcp", {
          method: "OPTIONS", headers: {
            Origin: origin, "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type,authorization,mcp-protocol-version,mcp-session-id,last-event-id",
          },
        });
        if (!allowedOrigins.includes(origin)) {
          for (const rejected of [response, preflight]) {
            assert.equal(rejected.status, 403);
            assert.equal(rejected.headers["access-control-allow-origin"], undefined);
          }
          continue;
        }
        assert.equal(response.status, 200);
        assert.equal(response.headers["access-control-allow-origin"], origin);
        assert.match(response.headers.vary, /Origin/i);
        const exposed = response.headers["access-control-expose-headers"].toLowerCase().split(",").map((value) => value.trim());
        for (const header of ["mcp-session-id", "www-authenticate", "x-request-id"]) assert.ok(exposed.includes(header));
        assert.equal(response.headers["access-control-allow-credentials"], undefined);
        assert.equal(preflight.status, 204);
        assert.equal(preflight.body, "");
        assert.equal(preflight.headers["access-control-allow-origin"], origin);
        const methods = preflight.headers["access-control-allow-methods"].split(",").map((value) => value.trim());
        for (const method of ["POST", "GET", "DELETE"]) assert.ok(methods.includes(method));
        const headers = preflight.headers["access-control-allow-headers"].toLowerCase().split(",").map((value) => value.trim());
        for (const header of ["content-type", "authorization", "mcp-protocol-version", "mcp-session-id", "last-event-id"]) assert.ok(headers.includes(header));
      }
    });

    await t.test("SDK clients initialize and discover tools with native and permitted browser requests", async (s) => {
      for (const origin of [undefined, ...allowedOrigins]) {
        const client = new Client({ name: "http-sdk-verifier", version: "1.0.0" });
        const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
          requestInit: origin ? { headers: { Origin: origin } } : undefined,
        });
        s.after(() => client.close());
        await client.connect(transport);
        assert.equal(transport.sessionId, undefined);
        assert.equal((await client.listTools()).tools.length, 14);
        const result = await client.callTool({ name: "get-epm-connection-status", arguments: {} });
        assert.ok(!result.isError);
        assert.equal(result.structuredContent.connection.configured, true);
        assertSafe(result);
        await client.close();
      }
    });

    await t.test("POST content negotiation rejects missing or unsupported media types", async () => {
      for (const Accept of [undefined, "", "*/*", "application/json", "text/event-stream", "text/plain"]) {
        jsonError(await post(message(1), { headers: { Accept } }), 406, -32000);
      }
      for (const contentType of [undefined, "text/plain", "application/xml", "application/jsonp", "text/application/json"]) {
        jsonError(await post(message(1), { headers: { "Content-Type": contentType } }), 415, -32000);
      }
      const response = await post(message("charset"), { headers: { "Content-Type": "application/json; charset=utf-8" } });
      assert.equal(rpcResponse(response, "charset").result.tools.length, 14);
    });

    await t.test("JSON parser rejects malformed, oversized, and unsupported-encoding bodies safely", async () => {
      for (const [body, extraHeaders, status, error] of [
        ['{"private":"http-private-json"', {}, 400, "Invalid JSON request body."],
        [JSON.stringify({ private: "http-private-json".repeat(8000) }), {}, 413, "Request body is too large."],
        [JSON.stringify(message(1)), { "Content-Type": "application/json; charset=iso-8859-1" }, 415, "Unsupported request encoding."],
        [JSON.stringify(message(1)), { "Content-Encoding": "unsupported" }, 415, "Unsupported request encoding."],
      ]) {
        const response = await request("/mcp?token=http-private-query", {
          method: "POST", body, headers: {
            Accept: "application/json, text/event-stream", "Content-Type": "application/json",
            Authorization: "Bearer http-private-bearer", Cookie: "session=http-private-cookie", ...extraHeaders,
          },
        });
        assert.equal(response.status, status);
        assert.match(response.headers["content-type"], /^application\/json\b/);
        assert.deepEqual(JSON.parse(response.body), { error });
      }
    });

    await t.test("invalid JSON-RPC envelopes receive structured transport errors", async () => {
      for (const value of [{}, { jsonrpc: "1.0", id: 1, method: "tools/list" }, { jsonrpc: "2.0", id: true, method: "tools/list" },
        { jsonrpc: "2.0", id: 1, method: 42 }, { jsonrpc: "2.0", id: 1, method: "tools/list", params: "invalid" }]) {
        jsonError(await post(value), 400, -32700);
      }
    });

    await t.test("unknown MCP methods and invalid tool calls retain JSON-RPC IDs", async () => {
      const unknown = rpcResponse(await post(message("unknown-method", "unsupported/method")), "unknown-method");
      assert.equal(unknown.error.code, -32601);
      for (const [id, params, expected] of [
        ["unknown-tool", { name: "unknown-tool", arguments: {} }, /not found/i],
        ["missing-argument", { name: "get-epm-member", arguments: {} }, /invalid arguments/i],
        ["wrong-type", { name: "list-epm-dimensions", arguments: { planType: 42 } }, /invalid arguments/i],
        ["invalid-range", { name: "get-epm-job-details", arguments: { jobId: 1, limit: -1 } }, /invalid arguments/i],
      ]) {
        const reply = rpcResponse(await post(message(id, "tools/call", params)), id);
        assert.equal(reply.result.isError, true);
        assert.match(reply.result.content[0].text, expected);
      }
      const malformed = rpcResponse(await post(message("bad-params", "tools/call", { arguments: {} })), "bad-params");
      // SDK 1.32 reports schema failures before dispatch as -32603; accept -32602 if corrected upstream.
      assert.ok([-32602, -32603].includes(malformed.error.code));
      assert.equal(typeof malformed.error.message, "string");
    });

    await t.test("initialization negotiates supported versions without issuing sessions", async () => {
      for (const version of ["2025-03-26", "2025-06-18", protocolVersion]) {
        const response = await post(initialization(`init-${version}`, version), { headers: { "MCP-Protocol-Version": undefined } });
        const reply = rpcResponse(response, `init-${version}`);
        assert.equal(reply.result.protocolVersion, version);
        assert.ok(reply.result.capabilities.tools);
        assert.equal(typeof reply.result.serverInfo.name, "string");
      }
      // Unsupported initialization proposals are negotiated; unsupported subsequent headers are rejected.
      const response = await post(initialization("init-future", "2099-01-01"), { headers: { "MCP-Protocol-Version": undefined } });
      assert.equal(rpcResponse(response, "init-future").result.protocolVersion, protocolVersion);
    });

    await t.test("subsequent protocol headers accept supported versions and reject unsupported values", async () => {
      for (const version of [undefined, "2025-03-26", "2025-06-18", protocolVersion]) {
        const reply = rpcResponse(await post(message(1), { headers: { "MCP-Protocol-Version": version } }), 1);
        assert.equal(reply.result.tools.length, 14);
      }
      for (const version of ["2099-01-01", "invalid", ""]) {
        const headers = { "MCP-Protocol-Version": version };
        jsonError(await post(message(1), { headers }), 400, -32000);
        jsonError(await request("/mcp", { headers: { ...headers, Accept: "text/event-stream" } }), 400, -32000);
        jsonError(await request("/mcp", { method: "DELETE", headers }), 400, -32000);
      }
    });

    await t.test("notifications and client responses receive empty accepted responses", async () => {
      for (const value of [
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 123, reason: "test cancellation" } },
        { jsonrpc: "2.0", id: 123, result: {} },
        { jsonrpc: "2.0", id: 123, error: { code: -32603, message: "test response" } },
      ]) {
        const response = await post(value);
        assert.equal(response.status, 202);
        assert.equal(response.body, "");
      }
    });

    await t.test("GET streams can be cancelled and DELETE does not invalidate later stateless requests", async () => {
      for (const Accept of [undefined, "application/json"]) {
        jsonError(await request("/mcp", { headers: { Accept } }), 406, -32000);
      }
      await openStream();
      const removed = await request("/mcp", { method: "DELETE", headers: { "MCP-Protocol-Version": protocolVersion } });
      assert.equal(removed.status, 200);
      assert.equal(removed.body, "");
      assert.equal(rpcResponse(await post(message("after-delete")), "after-delete").result.tools.length, 14);
    });

    await t.test("unsupported HTTP methods return method errors and an Allow header", async () => {
      for (const method of ["PUT", "PATCH", "HEAD"]) {
        const response = await request("/mcp", { method });
        assert.equal(response.status, 405);
        assert.deepEqual(response.headers.allow.split(",").map((value) => value.trim()).sort(), ["DELETE", "GET", "POST"]);
        if (method === "HEAD") assert.equal(response.body, "");
        else jsonError(response, 405, -32000);
      }
    });

    await t.test("concurrent clients may reuse RPC IDs without sharing sessions or responses", async () => {
      const requests = Array.from({ length: 8 }, (_, index) => {
        const status = index % 2 === 0;
        return post(message(7, status ? "tools/call" : "tools/list", status ? { name: "get-epm-connection-status", arguments: {} } : undefined), {
          headers: { "Mcp-Session-Id": index % 3 === 0 ? undefined : `untrusted-client-${index}` },
        }).then((response) => {
          const reply = rpcResponse(response, 7);
          if (status) {
            assert.equal(reply.result.structuredContent.connection.configured, true);
            assert.equal(reply.result.structuredContent.connection.username, "ht****");
            assert.equal(reply.result._meta.requestId, response.headers["x-request-id"]);
          } else assert.equal(reply.result.tools.length, 14);
          return response.headers["x-request-id"];
        });
      });
      const ids = await Promise.all(requests);
      assert.equal(new Set(ids).size, requests.length);
      for (let i = 0; i < 2; i++) assert.equal(rpcResponse(await post(initialization(7)), 7).result.protocolVersion, protocolVersion);
    });

    await t.test("valid requests still succeed after rejected requests and cancelled streams", async () => {
      const response = await post(message("recovered", "tools/call", { name: "get-epm-connection-status", arguments: {} }));
      const result = rpcResponse(response, "recovered").result;
      assert.ok(!result.isError);
      assert.equal(result._meta.requestId, response.headers["x-request-id"]);
      assert.equal(result.structuredContent.connection.configured, true);
      assert.equal((await request("/health")).status, 200);
    });
  });
}
