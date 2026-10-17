import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { ConfigurationError, readHttpConfig, validateOracleConfig } from "../dist/config.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(import.meta.dirname, "..");
const fixture = {
  EPM_BASE_URL: "https://example.oraclecloud.com/",
  EPM_USERNAME: "verification@example.com",
  EPM_PASSWORD: "verification-only-password",
};

test("Oracle configuration accepts an HTTPS origin and an optional default application", () => {
  assert.equal(validateOracleConfig(fixture), "https://example.oraclecloud.com");
  assert.equal(validateOracleConfig({ ...fixture, EPM_APPLICATION: "NSPB" }), "https://example.oraclecloud.com");
});

test("missing Oracle credentials are reported together without values", () => {
  assert.throws(() => validateOracleConfig({}), (error) => {
    assert.ok(error instanceof ConfigurationError);
    for (const name of ["EPM_BASE_URL", "EPM_USERNAME", "EPM_PASSWORD"]) assert.ok(error.message.includes(name));
    return true;
  });
  for (const name of ["EPM_BASE_URL", "EPM_USERNAME", "EPM_PASSWORD"]) {
    assert.throws(() => validateOracleConfig({ ...fixture, [name]: " \t " }), ConfigurationError);
  }
});

test("invalid Oracle URLs do not disclose submitted values", () => {
  for (const value of [
    "not-a-url-private-marker", "http://private-marker.example.com", "ftp://private-marker.example.com",
    "https://private-marker:private-password@example.com", "https://example.com/private-marker",
    "https://example.com?private-marker=private-password", "https://example.com#private-marker",
    "https://example.com\\private-marker", "https://exa mple.com/private-marker",
    "https://example.com/private-marker/..",
  ]) {
    assert.throws(() => validateOracleConfig({ ...fixture, EPM_BASE_URL: value }), (error) => {
      assert.ok(error instanceof ConfigurationError);
      assert.ok(error.message.includes("EPM_BASE_URL"));
      assert.ok(!error.message.includes("private-marker"));
      assert.ok(!error.message.includes("private-password"));
      return true;
    });
  }
});

test("HTTP configuration preserves defaults and accepts Render and IPv6 settings", () => {
  assert.deepEqual(readHttpConfig({}), {
    host: "127.0.0.1", port: 3001, allowedHosts: ["localhost", "127.0.0.1", "[::1]"], allowedOrigins: [], shutdownTimeoutMs: 25000,
  });
  assert.deepEqual(readHttpConfig({
    HOST: "0.0.0.0", PORT: "10000", MCP_ALLOWED_HOSTS: "MCP.EXAMPLE.COM, [::1],mcp.example.com",
  }), { host: "0.0.0.0", port: 10000, allowedHosts: ["mcp.example.com", "[::1]"], allowedOrigins: [], shutdownTimeoutMs: 25000 });
  assert.equal(readHttpConfig({ HOST: "::1", PORT: "0" }).port, 0);
  assert.equal(readHttpConfig({ SHUTDOWN_TIMEOUT_MS: "5000" }).shutdownTimeoutMs, 5000);
});

test("browser origins are explicit, normalized, and validated without exposing submitted values", () => {
  assert.deepEqual(readHttpConfig({ MCP_ALLOWED_ORIGINS: "" }).allowedOrigins, []);
  assert.deepEqual(readHttpConfig({ MCP_ALLOWED_ORIGINS: "  " }).allowedOrigins, []);
  assert.deepEqual(readHttpConfig({
    MCP_ALLOWED_ORIGINS: "http://localhost:5173, HTTPS://GUI.EXAMPLE.COM:443/,https://gui.example.com,http://[::1]:5173",
  }).allowedOrigins, ["http://localhost:5173", "https://gui.example.com", "http://[::1]:5173"]);
  for (const MCP_ALLOWED_ORIGINS of [
    "*", "null", "gui.example.com", "ftp://gui.example.com", "https://*.example.com",
    "https://user:private-marker@gui.example.com", "https://gui.example.com/private-marker",
    "https://gui.example.com?private-marker", "https://gui.example.com#private-marker",
    "https://gui.example.com/path/..", "https://gui.example.com,", ",", "https://gui.example.com\\private-marker",
  ]) {
    assert.throws(() => readHttpConfig({ MCP_ALLOWED_ORIGINS }), (error) => {
      assert.ok(error instanceof ConfigurationError);
      assert.match(error.message, /MCP_ALLOWED_ORIGINS/);
      assert.ok(!error.message.includes("private-marker"));
      return true;
    });
  }
});

test("HTTP configuration rejects malformed ports, addresses, and allowlist entries", () => {
  for (const SHUTDOWN_TIMEOUT_MS of ["", " ", "0", "-1", "1.5", "1e3", "2147483648", "invalid"]) {
    assert.throws(() => readHttpConfig({ SHUTDOWN_TIMEOUT_MS }), /SHUTDOWN_TIMEOUT_MS/);
  }
  for (const PORT of ["", " ", "-1", "65536", "3001abc", "3.5", "1e3", "0x10"]) {
    assert.throws(() => readHttpConfig({ PORT }), /PORT must/);
  }
  for (const HOST of ["", "https://localhost", "localhost:3001", "[::1]", "bad host", "999.999.999.999"]) {
    assert.throws(() => readHttpConfig({ HOST }), /HOST must/);
  }
  for (const MCP_ALLOWED_HOSTS of ["", ",", "localhost,", "https://mcp.example.com", "localhost:3001", "example.com/mcp", "*.example.com", "::1"]) {
    assert.throws(() => readHttpConfig({ MCP_ALLOWED_HOSTS }), /MCP_ALLOWED_HOSTS must/);
  }
});

test("startup exits with a sanitized error before opening HTTP or stdio transports", () => {
  for (const args of [[], ["--stdio"]]) {
    const result = spawnSync(process.execPath, [path.join(root, "dist/main.js"), ...args], {
      cwd: root,
      env: { ...process.env, ...fixture, EPM_BASE_URL: "https://private-marker:private-password@example.com" },
      encoding: "utf8", timeout: 10000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /EPM_BASE_URL/);
    for (const secret of ["private-marker", "private-password", fixture.EPM_USERNAME, fixture.EPM_PASSWORD]) {
      assert.ok(!result.stderr.includes(secret));
    }
    assert.ok(!result.stderr.includes("at validateOracleConfig"), "Configuration errors should not dump a stack trace");
  }
  const result = spawnSync(process.execPath, [path.join(root, "dist/main.js")], {
    cwd: root, env: { ...process.env, ...fixture, HOST: "private-marker.invalid/path", PORT: "bad" },
    encoding: "utf8", timeout: 10000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /HOST must/);
  assert.match(result.stderr, /PORT must/);
  assert.ok(!result.stderr.includes("private-marker"));
});

test("stdio ignores HTTP settings and supports discovery without a default application", async () => {
  const client = new Client({ name: "config-verifier", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [path.join(root, "dist/main.js"), "--stdio"], cwd: root,
    env: { ...fixture, EPM_APPLICATION: "", HOST: "invalid/path", PORT: "bad", MCP_ALLOWED_HOSTS: "", MCP_ALLOWED_ORIGINS: "*", SHUTDOWN_TIMEOUT_MS: "bad" },
  });
  try {
    await client.connect(transport);
    assert.ok((await client.listTools()).tools.some(({ name }) => name === "list-epm-applications"));
    const status = await client.callTool({ name: "get-epm-connection-status", arguments: {} });
    assert.equal(status.structuredContent.connection.baseUrl, "https://example.oraclecloud.com");
    assert.equal(status.structuredContent.connection.configured, true);
    assert.deepEqual(status.structuredContent.connection.missing, []);
    assert.ok(!status.content[0].text.includes("undefined"));
    const missingApplication = await client.callTool({ name: "list-epm-plan-types", arguments: {} });
    assert.equal(missingApplication.isError, true);
    assert.match(missingApplication.content[0].text, /EPM_APPLICATION/);
  } finally {
    await client.close();
  }
});
