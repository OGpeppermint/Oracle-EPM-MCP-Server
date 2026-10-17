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
];
const client = new Client({ name: "oracle-epm-server-verifier", version: "1.0.0" });
const root = path.resolve(import.meta.dirname, "..");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--env-file-if-exists=.env", path.join(root, "dist/main.js"), "--stdio"],
  cwd: root,
});
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(({ name }) => name).sort(), [...expectedTools].sort());
  for (const tool of tools) {
    assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} must be read-only`);
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
  console.log(`Verified ${tools.length} read-only MCP tools, connection status, and absence of GUI resources and execution tools.`);
} finally {
  await client.close();
}
