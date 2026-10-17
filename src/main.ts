import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import cors from "cors";
import type { Request, Response } from "express";
import { createServer } from "./server.js";

async function startHttp(factory: () => McpServer): Promise<void> {
  const host = process.env.HOST?.trim() || "127.0.0.1";
  const port = Number(process.env.PORT ?? "3001");
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("PORT must be an integer between 0 and 65535.");
  }
  const allowedHosts = (process.env.MCP_ALLOWED_HOSTS ?? "localhost,127.0.0.1,[::1]")
    .split(",").map((value) => value.trim()).filter(Boolean);
  if (!allowedHosts.length) throw new Error("MCP_ALLOWED_HOSTS must contain at least one hostname.");
  const app = createMcpExpressApp({ host, allowedHosts });
  app.use(cors());
  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok" });
  });
  app.all("/mcp", async (req: Request, res: Response) => {
    const server = factory();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { void transport.close(); void server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("MCP request failed", error);
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  });
  const listener = app.listen(port, host, () => {
    const address = listener.address();
    const listeningPort = address && typeof address === "object" ? address.port : port;
    const urlHost = host.includes(":") ? `[${host}]` : host;
    console.log(`Oracle EPM MCP server listening on http://${urlHost}:${listeningPort}/mcp`);
  });
}

if (process.argv.includes("--stdio")) {
  await createServer().connect(new StdioServerTransport());
} else {
  await startHttp(createServer);
}
