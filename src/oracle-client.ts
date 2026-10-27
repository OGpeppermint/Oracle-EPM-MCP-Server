import { setTimeout as delay } from "node:timers/promises";
import { oracleAuthMode, readOracleRequestConfig } from "./config.js";
import { log } from "./logging.js";
import { oracleAuthorizationHeader } from "./oracle-oauth.js";

const activeOracleRequests = new Map<AbortController, Promise<unknown>>();
const retryStatuses = new Set([429, 502, 503, 504]);
const transientNetworkCodes = new Set([
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET",
]);

export class EpmOperationError extends Error {
  constructor(readonly code: string, message: string, readonly status?: number) { super(message); }
}

export class EpmHttpError extends EpmOperationError {
  constructor(status: number) {
    const guidance = status === 401 ? (oracleAuthMode() === "oauth" ? "Check the Oracle user's EPM access, token scope, and service secondary audience; sign in again if needed." : "Check the server's Oracle credentials.")
      : status === 403 ? "Check the Oracle service account's access permissions."
      : status === 404 ? "Check that the requested Oracle resource exists."
      : status === 429 ? "Oracle is rate limiting requests; try again later."
      : status >= 500 ? "Oracle is temporarily unavailable; try again later."
      : "Check the requested operation and server configuration.";
    super("EPM_HTTP_ERROR", `Oracle EPM returned HTTP ${status}. ${guidance}`, status);
    this.name = "EpmHttpError";
  }
}

export async function closeOracleRequests(): Promise<void> {
  const pending = [...activeOracleRequests];
  for (const [controller] of pending) controller.abort();
  await Promise.allSettled(pending.map(([, request]) => request));
}

function responseTooLarge(): EpmOperationError {
  return new EpmOperationError("EPM_RESPONSE_TOO_LARGE", "Oracle EPM returned a response larger than the configured limit. Request fewer fields, paginate results, or narrow the data slice.");
}

async function readBody(response: Response, limit: number, signal: AbortSignal): Promise<string> {
  // Content-Length can describe compressed bytes. Always enforce the decoded stream limit too.
  const contentLength = response.headers.get("content-length");
  if (!response.headers.get("content-encoding") && contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > limit) {
    await response.body?.cancel().catch(() => {});
    throw responseTooLarge();
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) throw responseTooLarge();
      chunks.push(value);
    }
    return new TextDecoder().decode(Buffer.concat(chunks, bytes));
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

function retryAfterMilliseconds(value: string | null): number | undefined {
  if (value === null) return undefined;
  const raw = value.trim();
  if (/^\d+$/.test(raw)) return Number(raw) * 1000;
  // Avoid Date.parse interpreting a negative/fractional seconds value as a calendar date.
  if (!/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)/i.test(raw)) return undefined;
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function isTransientNetworkError(error: unknown): boolean {
  if (!(error instanceof TypeError)) return false;
  if (error.cause === undefined) return true;
  const code = error.cause && typeof error.cause === "object" && "code" in error.cause ? error.cause.code : undefined;
  return typeof code === "string" && transientNetworkCodes.has(code);
}

export async function epmRequest<T>(
  pathName: string,
  init?: RequestInit,
  { summaryFallback = false }: { summaryFallback?: boolean } = {},
): Promise<T> {
  if (!process.env.EPM_BASE_URL) throw new EpmOperationError("EPM_CONFIGURATION_MISSING", "Oracle EPM base URL is not configured.");
  const config = readOracleRequestConfig();
  const headers = new Headers(init?.headers);
  headers.set("Authorization", await oracleAuthorizationHeader());
  headers.set("Accept", "application/json");
  if (init?.body === undefined) headers.delete("Content-Type");
  else if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const method = (init?.method ?? "GET").toUpperCase();
  const canRetry = method === "GET";
  const controller = new AbortController();
  const signal = AbortSignal.any([
    AbortSignal.timeout(config.timeoutMs), controller.signal, ...(init?.signal ? [init.signal] : []),
  ]);
  const deadline = performance.now() + config.timeoutMs;
  const request = (async () => {
    let retries = 0;
    let attempts = 0;
    let usedSummaryFallback = false;
    for (;;) {
      signal.throwIfAborted();
      let failure: unknown;
      let retryable = false;
      let retryAfter: number | undefined;
      try {
        attempts++;
        const response = await fetch(`${process.env.EPM_BASE_URL}${pathName}`, { ...init, method, headers, signal });
        signal.throwIfAborted();
        if (!response.ok) {
          retryAfter = retryAfterMilliseconds(response.headers.get("retry-after"));
          await response.body?.cancel().catch(() => {});
          if (summaryFallback && canRetry && response.status === 406 && !usedSummaryFallback) {
            usedSummaryFallback = true;
            headers.set("Accept", "*/*");
            continue;
          }
          retryable = retryStatuses.has(response.status);
          throw new EpmHttpError(response.status);
        }
        const body = await readBody(response, config.maxResponseBytes, signal);
        if (!body) return {} as T;
        const responseType = response.headers.get("content-type")?.toLowerCase() ?? "";
        if (responseType.includes("text/plain") || responseType.includes("text/markdown")) return body as T;
        try {
          if (responseType && !responseType.includes("json")) throw new Error();
          return JSON.parse(body) as T;
        } catch {
          throw new EpmOperationError("EPM_RESPONSE_FORMAT", "Oracle EPM returned an invalid or unsupported response format.");
        }
      } catch (error) {
        signal.throwIfAborted();
        failure = error;
        retryable ||= isTransientNetworkError(error);
      }
      if (!canRetry || !retryable || retries >= config.maxRetries) throw failure;
      // Equal jitter: 250–500 ms, 500–1000 ms, then exponential growth capped at 5 s.
      const ceiling = Math.min(5000, 500 * 2 ** retries);
      const waitMs = Math.max(ceiling / 2 + Math.random() * ceiling / 2, retryAfter ?? 0);
      if (waitMs >= deadline - performance.now()) throw failure;
      retries++;
      log("warn", "oracle.request.retry", {
        attempt: attempts + 1, delayMs: Math.ceil(waitMs),
        status: failure instanceof EpmHttpError ? failure.status : undefined,
        errorCode: failure instanceof EpmOperationError ? failure.code : "EPM_NETWORK_ERROR",
      });
      await delay(Math.ceil(waitMs), undefined, { signal });
    }
  })().catch((error: unknown) => {
    if (signal.aborted) {
      if (signal.reason instanceof DOMException && signal.reason.name === "TimeoutError") {
        throw new EpmOperationError("EPM_TIMEOUT", "The Oracle EPM request timed out. Try again later.");
      }
      throw new EpmOperationError("EPM_ABORTED", "The Oracle EPM request was cancelled.");
    }
    if (error instanceof EpmOperationError) throw error;
    throw new EpmOperationError("EPM_NETWORK_ERROR", "Unable to communicate with Oracle EPM. Check server connectivity and configuration.");
  });
  activeOracleRequests.set(controller, request);
  try { return await request; }
  finally { activeOracleRequests.delete(controller); }
}
