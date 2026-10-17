import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import cors from "cors";
import type { Request, Response } from "express";
import { ConfigurationError, readHttpConfig, validateOracleConfig, type HttpConfig } from "./config.js";
import { createServer } from "./server.js";

async function startHttp(factory: () => McpServer, { host, port, allowedHosts, allowedOrigins }: HttpConfig): Promise<void> {
  const app = createMcpExpressApp({ host, allowedHosts });
  app.use((req, res, next) => {
    res.vary("Origin");
    if (req.headers.origin !== undefined && !allowedOrigins.includes(req.headers.origin)) {
      res.status(403).json({ error: "Request origin is not allowed." });
      return;
    }
    next();
  });
  app.use(cors({
    origin: allowedOrigins,
    methods: ["GET", "HEAD", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Accept", "Content-Type", "Authorization", "MCP-Protocol-Version", "Mcp-Session-Id", "Last-Event-ID"],
    exposedHeaders: ["Mcp-Session-Id", "WWW-Authenticate"],
  }));
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

try {
  process.env.EPM_BASE_URL = validateOracleConfig();
  if (process.argv.includes("--stdio")) {
    await createServer().connect(new StdioServerTransport());
  } else {
    await startHttp(createServer, readHttpConfig());
  }
} catch (error) {
  if (!(error instanceof ConfigurationError)) throw error;
  console.error(error.message);
  process.exitCode = 1;
}
