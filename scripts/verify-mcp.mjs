import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const expectedUiTools = [
  "get-epm-api-versions",
  "list-epm-applications",
  "get-epm-application-summary",
  "list-epm-plan-types",
  "list-epm-dimensions",
  "get-epm-dimension",
  "get-epm-member",
  "list-epm-job-definitions",
  "get-epm-job-status",
  "get-epm-job-details",
  "list-epm-substitution-variables",
  "get-epm-substitution-variable",
  "export-epm-data-slice",
];
const intentionallyDisabledTools = ["execute-epm-job", "run-epm-business-rule"];
const resourceUri = "ui://oracle-epm-nspb/command-center.html";

const client = new Client({ name: "oracle-epm-ui-verifier", version: "1.0.0" });
const transport = new StdioClientTransport({ command: "node", args: ["dist/main.js", "--stdio"] });

try {
  await client.connect(transport);
  const listed = await client.listTools();
  const resources = await client.listResources();
  const resource = await client.readResource({ uri: resourceUri });
  const html = resource.contents[0]?.text ?? "";
  const toolsByName = new Map(listed.tools.map((tool) => [tool.name, tool]));
  const missingTools = expectedUiTools.filter((name) => !toolsByName.has(name));
  const unlinkedTools = expectedUiTools.filter((name) => toolsByName.get(name)?._meta?.ui?.resourceUri !== resourceUri);
  const hiddenFromApp = expectedUiTools.filter((name) => !toolsByName.get(name)?._meta?.ui?.visibility?.includes("app"));
  const unexpectedlyEnabledTools = intentionallyDisabledTools.filter((name) => toolsByName.has(name));
  const missingTabs = ["Start with context", "Explore metadata", "Export a data slice", "Inspect jobs"].filter((marker) => !html.includes(marker));
  const resourceValid = resources.resources.some(({ uri, mimeType }) => uri === resourceUri && mimeType === "text/html;profile=mcp-app");
  const failures = { missingTools, unlinkedTools, hiddenFromApp, unexpectedlyEnabledTools, missingTabs, resourceValid };

  console.log(JSON.stringify({ toolCount: listed.tools.length, htmlBytes: html.length, ...failures }, null, 2));
  if (missingTools.length || unlinkedTools.length || hiddenFromApp.length || unexpectedlyEnabledTools.length || missingTabs.length || !resourceValid) process.exitCode = 1;
} finally {
  await client.close();
}
