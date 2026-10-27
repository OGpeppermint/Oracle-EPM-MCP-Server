import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import cors from "cors";
import type { ErrorRequestHandler, Request, Response } from "express";
import { createServer as createHttpServer } from "node:http";
import { ConfigurationError, oracleAuthMode, readHttpConfig, readOracleRequestConfig, validateOracleConfig, type HttpConfig } from "./config.js";
import { createServer } from "./server.js";
import { closeOracleRequests } from "./oracle-client.js";
import { manageHttpShutdown } from "./shutdown.js";
import { handleHttpRequest, log } from "./logging.js";
import { startOracleOAuthListener, stopOracleOAuthListener } from "./oracle-oauth.js";

async function startHttp(factory: () => McpServer, { host, port, allowedHosts, allowedOrigins, shutdownTimeoutMs }: HttpConfig): Promise<void> {
  const app = createMcpExpressApp({ host, allowedHosts });
  const listener = createHttpServer((req, res) => handleHttpRequest(req, res, () => { app(req, res); }));
  const lifecycle = manageHttpShutdown(listener, shutdownTimeoutMs);
  lifecycle.track(closeOracleRequests);
  lifecycle.track(stopOracleOAuthListener);
  app.use((_req, res, next) => {
    if (lifecycle.shuttingDown) {
      res.setHeader("Connection", "close");
      res.status(503).json({ error: "Server is shutting down." });
      return;
    }
    next();
  });
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
    exposedHeaders: ["Mcp-Session-Id", "WWW-Authenticate", "X-Request-Id"],
  }));
  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok" });
  });
  app.all("/mcp", async (req: Request, res: Response) => {
    const server = factory();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    // McpServer.close() also closes its connected transport.
    const release = lifecycle.track(() => server.close(), req.method === "GET");
    res.once("close", () => { void release(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      log("error", "mcp.request.failed", { errorCode: "MCP_TRANSPORT_ERROR" });
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      else res.destroy();
    }
  });
  const handleError: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    const type = error && typeof error === "object" && "type" in error ? error.type : undefined;
    const status = type === "entity.parse.failed" ? 400 : type === "entity.too.large" ? 413
      : type === "encoding.unsupported" || type === "charset.unsupported" ? 415 : 500;
    const message = status === 400 ? "Invalid JSON request body." : status === 413 ? "Request body is too large."
      : status === 415 ? "Unsupported request encoding." : "Internal server error.";
    log(status === 500 ? "error" : "warn", "http.request.failed", { status, errorCode: `HTTP_${status}` });
    if (res.headersSent) { res.destroy(); return; }
    res.status(status).json({ error: message });
  };
  app.use(handleError);
  listener.once("error", () => {
    log("error", "server.listen.failed", { errorCode: "HTTP_LISTEN_FAILED" });
    process.exitCode = 1;
    void lifecycle.shutdown("startup-error");
  });
  listener.listen(port, host, () => {
    const address = listener.address();
    const listeningPort = address && typeof address === "object" ? address.port : port;
    log("info", "server.listening", { transport: "http", port: listeningPort });
  });
}

try {
  process.env.EPM_BASE_URL = validateOracleConfig();
  readOracleRequestConfig();
  const stdio = process.argv.includes("--stdio");
  const http = stdio ? undefined : readHttpConfig();
  if (http && oracleAuthMode() === "oauth" && !["127.0.0.1", "::1", "localhost"].includes(http.host.toLowerCase()))
    throw new ConfigurationError(["OAuth browser sign-in requires local HTTP binding (HOST=127.0.0.1, ::1, or localhost)."]);
  await startOracleOAuthListener();
  if (stdio) {
    const transport = new StdioServerTransport();
    transport.onclose = () => { void stopOracleOAuthListener(); };
    await createServer().connect(transport);
  } else {
    await startHttp(createServer, http!);
  }
} catch (error) {
  await stopOracleOAuthListener().catch(() => {});
  if (error instanceof ConfigurationError) {
    log("error", "server.configuration.invalid", { errorCode: "CONFIGURATION_INVALID", message: error.message });
  } else {
    log("error", "server.start.failed", { errorCode: "STARTUP_FAILED" });
  }
  process.exitCode = 1;
}
