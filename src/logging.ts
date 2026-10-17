import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

const context = new AsyncLocalStorage<{ requestId: string }>();
type LogFields = {
  requestId?: string;
  operation?: string;
  method?: string;
  route?: string;
  status?: number;
  durationMs?: number;
  outcome?: string;
  errorCode?: string;
  signal?: string;
  port?: number;
  transport?: string;
  message?: string;
};
const fieldNames = new Set([
  "requestId", "operation", "method", "route", "status", "durationMs", "outcome",
  "errorCode", "signal", "port", "transport", "message",
]);

// Callers supply safe scalar metadata, never raw exceptions, bodies, arguments, or headers.
export function log(level: "info" | "warn" | "error", event: string, fields: LogFields = {}): void {
  const record: Record<string, string | number> = { timestamp: new Date().toISOString(), level, event };
  const requestId = context.getStore()?.requestId;
  if (requestId) record.requestId = requestId;
  for (const [key, value] of Object.entries(fields)) {
    if (fieldNames.has(key) && (typeof value === "string" || (typeof value === "number" && Number.isFinite(value)))) {
      record[key] = value;
    }
  }
  process.stderr.write(`${JSON.stringify(record)}\n`);
}

export function getRequestId(): string | undefined {
  return context.getStore()?.requestId;
}

export function withRequestContext<T>(callback: () => T): T {
  return context.getStore() ? callback() : context.run({ requestId: randomUUID() }, callback);
}

// Wrap Express itself so SDK hostname rejection and JSON parser errors also get an ID and access log.
export function handleHttpRequest(req: IncomingMessage, res: ServerResponse, handle: () => void): void {
  const requestId = randomUUID();
  context.run({ requestId }, () => {
    res.setHeader("X-Request-Id", requestId);
    const started = performance.now();
    const pathname = req.url?.split("?", 1)[0];
    const route = pathname === "/mcp" || pathname === "/health" ? pathname : "other";
    const method = ["GET", "HEAD", "POST", "DELETE", "OPTIONS", "PUT", "PATCH", "CONNECT", "TRACE"].includes(req.method ?? "")
      ? req.method : "OTHER";
    let recorded = false;
    const complete = () => {
      if (recorded) return;
      recorded = true;
      const outcome = res.writableFinished ? "completed" : "aborted";
      log(res.statusCode >= 500 ? "error" : res.statusCode >= 400 || outcome === "aborted" ? "warn" : "info", "http.request.completed", {
        requestId, method, route, status: res.statusCode, outcome,
        durationMs: Math.round((performance.now() - started) * 100) / 100,
      });
    };
    res.once("finish", complete);
    res.once("close", complete);
    handle();
  });
}
