import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { oracleAuthMode, readOAuthConfig, type OAuthConfig } from "./config.js";
import { EpmOperationError } from "./oracle-client.js";

const callbackPath = "/oauth/epm/callback";
const pendingLifetimeMs = 10 * 60 * 1000;
type Pending = { state: string; verifier: string; expiresAt: number };
type Tokens = { accessToken: string; refreshToken?: string; expiresAt: number };
let listener: Server | undefined;
let pending: Pending | undefined;
let tokens: Tokens | undefined;
let refreshPromise: Promise<string> | undefined;

function redirectUri(config: OAuthConfig): string {
  return `http://127.0.0.1:${config.callbackPort}${callbackPath}`;
}

function randomBase64url(): string { return randomBytes(32).toString("base64url"); }

function sameState(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function openBrowser(url: string): boolean {
  const command = process.platform === "win32" ? "rundll32.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch { return false; }
}

async function tokenRequest(config: OAuthConfig, values: URLSearchParams): Promise<Tokens> {
  let response: Response;
  try {
    response = await fetch(`${config.domainUrl}/oauth2/v1/token`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: values, signal: AbortSignal.timeout(30000), redirect: "error",
    });
  } catch {
    throw new EpmOperationError("EPM_OAUTH_NETWORK_ERROR", "Could not contact the Oracle identity domain.");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new EpmOperationError("EPM_OAUTH_TOKEN_ERROR", `Oracle sign-in token request failed (HTTP ${response.status}). Check the client registration, redirect URI, and scope.`);
  }
  let data: unknown;
  try { data = await response.json(); } catch { throw new EpmOperationError("EPM_OAUTH_TOKEN_ERROR", "Oracle returned an invalid token response."); }
  if (!data || typeof data !== "object") throw new EpmOperationError("EPM_OAUTH_TOKEN_ERROR", "Oracle returned an invalid token response.");
  const value = data as Record<string, unknown>;
  if (typeof value.access_token !== "string" || !value.access_token
    || typeof value.token_type !== "string" || value.token_type.toLowerCase() !== "bearer"
    || typeof value.expires_in !== "number" || value.expires_in <= 0
    || !Number.isFinite(value.expires_in)) throw new EpmOperationError("EPM_OAUTH_TOKEN_ERROR", "Oracle returned incomplete token data.");
  return {
    accessToken: value.access_token,
    refreshToken: typeof value.refresh_token === "string" && value.refresh_token ? value.refresh_token : undefined,
    expiresAt: Date.now() + value.expires_in * 1000,
  };
}

export function beginOracleLogin({ launchBrowser = true }: { launchBrowser?: boolean } = {}): { authorizationUrl: string; browserOpened: boolean; expiresAt: string } {
  if (oracleAuthMode() !== "oauth" || !listener?.listening) throw new EpmOperationError("EPM_OAUTH_UNAVAILABLE", "Local Oracle browser sign-in is not enabled.");
  const config = readOAuthConfig();
  const state = randomBase64url();
  const verifier = randomBase64url();
  pending = { state, verifier, expiresAt: Date.now() + pendingLifetimeMs };
  const url = new URL(`${config.domainUrl}/oauth2/v1/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", redirectUri(config));
  url.searchParams.set("scope", `${config.scope} offline_access`);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
  url.searchParams.set("code_challenge_method", "S256");
  return { authorizationUrl: url.href, browserOpened: launchBrowser ? openBrowser(url.href) : false, expiresAt: new Date(pending.expiresAt).toISOString() };
}

export function oracleLoginStatus(): { mode: "basic" | "oauth"; signedIn: boolean; expiresAt?: string } {
  const mode = oracleAuthMode();
  return { mode, signedIn: mode === "basic" || !!tokens?.refreshToken || !!tokens && tokens.expiresAt > Date.now(),
    ...(mode === "oauth" && tokens ? { expiresAt: new Date(tokens.expiresAt).toISOString() } : {}) };
}

export async function oracleAuthorizationHeader(): Promise<string> {
  if (oracleAuthMode() === "basic") {
    if (!process.env.EPM_USERNAME || !process.env.EPM_PASSWORD) throw new EpmOperationError("EPM_CONFIGURATION_MISSING", "Oracle EPM Basic credentials are not configured.");
    return `Basic ${Buffer.from(`${process.env.EPM_USERNAME}:${process.env.EPM_PASSWORD}`).toString("base64")}`;
  }
  if (!tokens) throw new EpmOperationError("EPM_OAUTH_LOGIN_REQUIRED", "Sign in to Oracle EPM with start-epm-login before using this tool.");
  if (tokens.expiresAt > Date.now() + 60000) return `Bearer ${tokens.accessToken}`;
  if (!tokens.refreshToken) {
    tokens = undefined;
    throw new EpmOperationError("EPM_OAUTH_LOGIN_REQUIRED", "Oracle sign-in expired. Run start-epm-login again.");
  }
  refreshPromise ??= (async () => {
    const config = readOAuthConfig();
    const current = tokens!;
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: current.refreshToken!, client_id: config.clientId });
    try {
      const next = await tokenRequest(config, body);
      tokens = next;
      return `Bearer ${next.accessToken}`;
    } catch (error) {
      tokens = undefined;
      throw error;
    }
  })().finally(() => { refreshPromise = undefined; });
  return refreshPromise;
}

export async function startOracleOAuthListener(): Promise<void> {
  if (oracleAuthMode() !== "oauth") return;
  if (listener?.listening) return;
  const config = readOAuthConfig();
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (req.method !== "GET" || !req.url) { res.writeHead(404).end(); return; }
    let url: URL;
    try { url = new URL(req.url, redirectUri(config)); } catch { res.writeHead(400).end(); return; }
    if (url.pathname !== callbackPath) { res.writeHead(404).end(); return; }
    const current = pending;
    if (!current || current.expiresAt < Date.now() || !url.searchParams.has("state")
      || !sameState(url.searchParams.get("state")!, current.state)) {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("Oracle sign-in state is invalid or expired. Start sign-in again.");
      return;
    }
    pending = undefined;
    if (url.searchParams.has("error") || !url.searchParams.get("code")) {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("Oracle sign-in was cancelled or denied. Start sign-in again.");
      return;
    }
    try {
      const body = new URLSearchParams({ grant_type: "authorization_code", code: url.searchParams.get("code")!,
        redirect_uri: redirectUri(config), client_id: config.clientId, code_verifier: current.verifier });
      tokens = await tokenRequest(config, body);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        .end("<!doctype html><title>Oracle EPM sign-in</title><p>Oracle EPM sign-in completed. You can close this tab and return to your MCP client.</p>");
    } catch {
      res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" }).end("Oracle sign-in could not be completed. Check the client configuration and try again.");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.callbackPort, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  listener = server;
}

export async function stopOracleOAuthListener(): Promise<void> {
  pending = undefined;
  tokens = undefined;
  if (!listener) return;
  const current = listener;
  listener = undefined;
  await new Promise<void>((resolve) => current.close(() => resolve()));
}
