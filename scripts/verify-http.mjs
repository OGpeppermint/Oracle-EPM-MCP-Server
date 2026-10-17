import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const root = path.resolve(import.meta.dirname, "..");
const browserOrigins = ["https://command-center.example.com", "http://localhost:5173"];

async function verifyHttp(allowedOrigins) {
  const child = spawn(process.execPath, [path.join(root, "dist/main.js")], {
    cwd: root,
    env: {
      ...process.env,
      EPM_BASE_URL: "https://example.oraclecloud.com",
      EPM_USERNAME: "verification@example.com",
      EPM_PASSWORD: "verification-only-password",
      EPM_APPLICATION: "Verification",
      HOST: "127.0.0.1",
      PORT: "0",
      MCP_ALLOWED_HOSTS: "127.0.0.1, mcp.test",
      MCP_ALLOWED_ORIGINS: allowedOrigins.join(","),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const client = new Client({ name: "oracle-epm-http-verifier", version: "1.0.0" });
  const browserClient = new Client({ name: "oracle-epm-browser-verifier", version: "1.0.0" });
  let diagnostics = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => { diagnostics += chunk; });

  function request(url, hostname, { method = "GET", headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
      const request = http.request(url, { method, headers: { Host: hostname, ...headers } }, (response) => {
        let body = "";
        response.setEncoding("utf8").on("data", (chunk) => { body += chunk; });
        response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body }));
        response.on("error", reject);
      });
      request.setTimeout(5000, () => request.destroy(new Error("HTTP verification request timed out.")));
      request.on("error", reject);
      request.end(body);
    });
  }

  try {
    const baseUrl = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("HTTP server startup timed out.")), 10000);
      const cleanup = () => clearTimeout(timeout);
      let output = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => {
        output += chunk;
        const match = output.match(/listening on (http:\/\/127\.0\.0\.1:\d+)\/mcp/);
        if (match) { cleanup(); resolve(match[1]); }
      });
      child.once("error", (error) => { cleanup(); reject(error); });
      child.once("exit", (code) => {
        cleanup();
        reject(new Error(`HTTP server exited with code ${code}. ${diagnostics}`));
      });
    });

    const health = await request(`${baseUrl}/health`, "mcp.test");
    assert.equal(health.status, 200);
    assert.deepEqual(JSON.parse(health.body), { status: "ok" });
    assert.equal(health.headers["access-control-allow-origin"], undefined);
    for (const route of ["/health", "/mcp"]) {
      assert.equal((await request(`${baseUrl}${route}`, "unapproved.test")).status, 403);
    }

    for (const origin of browserOrigins) {
      const response = await request(`${baseUrl}/health`, "mcp.test", { headers: { Origin: origin } });
      const preflight = await request(`${baseUrl}/mcp`, "mcp.test", {
        method: "OPTIONS",
        headers: {
          Origin: origin,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type,authorization,mcp-protocol-version,mcp-session-id,last-event-id",
        },
      });
      if (allowedOrigins.includes(origin)) {
        assert.equal(response.status, 200);
        assert.equal(response.headers["access-control-allow-origin"], origin);
        assert.match(response.headers.vary, /Origin/i);
        assert.match(response.headers["access-control-expose-headers"], /Mcp-Session-Id/i);
        assert.match(response.headers["access-control-expose-headers"], /WWW-Authenticate/i);
        assert.equal(response.headers["access-control-allow-credentials"], undefined);
        assert.equal(preflight.status, 204);
        assert.equal(preflight.headers["access-control-allow-origin"], origin);
        assert.match(preflight.headers["access-control-allow-methods"], /POST/);
        assert.match(preflight.headers["access-control-allow-methods"], /DELETE/);
        for (const header of ["content-type", "authorization", "mcp-protocol-version", "mcp-session-id", "last-event-id"]) {
          assert.ok(preflight.headers["access-control-allow-headers"].toLowerCase().split(",").map((value) => value.trim()).includes(header));
        }
      } else {
        assert.equal(response.status, 403);
        assert.equal(preflight.status, 403);
        assert.equal(response.headers["access-control-allow-origin"], undefined);
        assert.equal(preflight.headers["access-control-allow-origin"], undefined);
      }
    }
    for (const origin of ["https://unapproved.test", "https://command-center.example.com.evil.test", "http://localhost:5174", "null"]) {
      for (const method of ["POST", "OPTIONS"]) {
        const rejected = await request(`${baseUrl}/mcp`, "mcp.test", {
          method, headers: { Origin: origin, "Content-Type": "application/json", "Access-Control-Request-Method": "POST" },
          body: method === "POST" ? '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' : undefined,
        });
        assert.equal(rejected.status, 403);
        assert.equal(rejected.headers["access-control-allow-origin"], undefined);
        assert.deepEqual(JSON.parse(rejected.body), { error: "Request origin is not allowed." });
        assert.match(rejected.headers.vary, /Origin/i);
      }
    }
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
    assert.ok((await client.listTools()).tools.length > 0);
    if (allowedOrigins.length) {
      await browserClient.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: { headers: { Origin: allowedOrigins[0] } },
      }));
      assert.ok((await browserClient.listTools()).tools.length > 0);
    }
    console.log(`Verified HTTP liveness, hostnames, CORS, preflight, and MCP connectivity (${allowedOrigins.length ? "explicit browser origins" : "no browser origins"}).`);
  } finally {
    try {
      await client.close();
      await browserClient.close();
    } finally {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill();
        await exited;
      }
    }
  }
}

await verifyHttp(browserOrigins);
await verifyHttp([]);
