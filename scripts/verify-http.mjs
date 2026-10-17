import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const root = path.resolve(import.meta.dirname, "..");
const child = spawn(process.execPath, [path.join(root, "dist/main.js")], {
  cwd: root,
  env: { ...process.env, HOST: "127.0.0.1", PORT: "0", MCP_ALLOWED_HOSTS: "127.0.0.1, mcp.test" },
  stdio: ["ignore", "pipe", "pipe"],
});
const client = new Client({ name: "oracle-epm-http-verifier", version: "1.0.0" });
let diagnostics = "";
child.stderr.setEncoding("utf8").on("data", (chunk) => { diagnostics += chunk; });

function get(url, hostname) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { headers: { Host: hostname } }, (response) => {
      let body = "";
      response.setEncoding("utf8").on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body }));
      response.on("error", reject);
    });
    request.setTimeout(5000, () => request.destroy(new Error("HTTP verification request timed out.")));
    request.on("error", reject);
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

  const health = await get(`${baseUrl}/health`, "mcp.test");
  assert.equal(health.status, 200);
  assert.deepEqual(JSON.parse(health.body), { status: "ok" });
  for (const route of ["/health", "/mcp"]) {
    assert.equal((await get(`${baseUrl}${route}`, "unapproved.test")).status, 403);
  }
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
  assert.ok((await client.listTools()).tools.length > 0);
  console.log("Verified HTTP liveness, allowed/rejected hostnames, and MCP connectivity.");
} finally {
  try {
    await client.close();
  } finally {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
  }
}
