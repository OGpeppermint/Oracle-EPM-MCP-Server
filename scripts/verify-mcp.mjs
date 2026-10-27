import assert from "node:assert/strict";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const expectedTools = [
  "get-epm-api-versions", "list-epm-applications", "get-epm-application-summary",
  "list-epm-plan-types", "list-epm-dimensions", "get-epm-dimension", "get-epm-member",
  "list-epm-job-definitions", "get-epm-job-status", "get-epm-job-details",
  "list-epm-substitution-variables", "get-epm-substitution-variable", "export-epm-data-slice",
  "get-epm-connection-status",
  "create-epm-rule",
];
const client = new Client({ name: "oracle-epm-server-verifier", version: "1.0.0" });
const root = path.resolve(import.meta.dirname, "..");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--env-file-if-exists=.env", path.join(root, "dist/main.js"), "--stdio"],
  cwd: root,
  env: {
    EPM_BASE_URL: "https://example.oraclecloud.com",
    EPM_USERNAME: "verification@example.com",
    EPM_PASSWORD: "verification-only-password",
    EPM_APPLICATION: "Verification",
  },
});
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(({ name }) => name).sort(), [...expectedTools].sort());
  for (const tool of tools) {
    assert.equal(tool.annotations?.readOnlyHint, tool.name !== "create-epm-rule", `${tool.name} has the wrong read-only annotation`);
    assert.equal(tool._meta?.ui, undefined, `${tool.name} must not link a GUI`);
    assert.equal(tool._meta?.["ui/resourceUri"], undefined);
  }
  assert.equal(client.getServerCapabilities()?.resources, undefined, "Server must not expose GUI resources");
  const result = await client.callTool({ name: "get-epm-connection-status", arguments: {} });
  assert.ok(!result.isError);
  assert.equal(typeof result.structuredContent?.connection?.configured, "boolean");
  assert.ok(Array.isArray(result.structuredContent?.connection?.missing));
  assert.ok(Number.isFinite(Date.parse(result.structuredContent?.checkedAt)));
  assert.equal(result.structuredContent?.connection?.password, undefined);
  assert.equal(tools.find(({ name }) => name === "create-epm-rule")?.annotations?.destructiveHint, true);
  console.log(`Verified ${tools.length} MCP tools, including create-epm-rule, connection status, and absence of GUI resources and generic execution tools.`);
} finally {
  await client.close();
}
