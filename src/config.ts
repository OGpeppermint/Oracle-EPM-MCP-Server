import { isIP } from "node:net";

export class ConfigurationError extends Error {
  constructor(issues: string[]) {
    super(`Invalid server configuration:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
    this.name = "ConfigurationError";
  }
}

export type HttpConfig = {
  host: string;
  port: number;
  allowedHosts: string[];
};

function isHostname(value: string): boolean {
  return value.length <= 253 && !/^[\d.]+$/.test(value)
    && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.?$/i.test(value);
}

function isAllowedHostname(value: string): boolean {
  if (value.startsWith("[") && value.endsWith("]")) return isIP(value.slice(1, -1)) === 6;
  return isIP(value) === 4 || isHostname(value);
}

// Return only the validated origin; never include credential values in errors.
export function validateOracleConfig(env: NodeJS.ProcessEnv = process.env): string {
  const issues: string[] = [];
  const baseUrl = env.EPM_BASE_URL?.trim();
  let origin = "";
  if (!baseUrl) {
    issues.push("EPM_BASE_URL is required. Set it to the HTTPS origin of your Oracle EPM environment.");
  } else {
    try {
      const url = new URL(baseUrl);
      if (!/^https:\/\/[^/?#\\]+\/?$/i.test(baseUrl) || /[\s\\@?#]/.test(baseUrl)
        || url.protocol !== "https:" || !url.hostname || url.pathname !== "/"
        || url.username || url.password || url.search || url.hash) throw new Error();
      origin = url.origin;
    } catch {
      issues.push("EPM_BASE_URL must be a valid HTTPS origin without embedded credentials, a path, a query, or a fragment.");
    }
  }
  for (const key of ["EPM_USERNAME", "EPM_PASSWORD"] as const) {
    if (!env[key]?.trim()) issues.push(`${key} is required and must not be blank. Set it in the environment or .env file.`);
  }
  // EPM_APPLICATION is optional: discovery and explicit application arguments work without it.
  if (issues.length) throw new ConfigurationError(issues);
  return origin;
}

export function readHttpConfig(env: NodeJS.ProcessEnv = process.env): HttpConfig {
  const issues: string[] = [];
  const host = env.HOST === undefined ? "127.0.0.1" : env.HOST.trim();
  if (!isIP(host) && !isHostname(host)) {
    issues.push("HOST must be an IP address or hostname without a scheme, port, path, or IPv6 brackets.");
  }
  const rawPort = env.PORT === undefined ? "3001" : env.PORT.trim();
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 0 || port > 65535) {
    issues.push("PORT must be an integer between 0 and 65535. Use 0 only to request a temporary port.");
  }
  const allowedHosts = (env.MCP_ALLOWED_HOSTS ?? "localhost,127.0.0.1,[::1]")
    .split(",").map((value) => value.trim().toLowerCase());
  if (allowedHosts.some((value) => !isAllowedHostname(value))) {
    issues.push("MCP_ALLOWED_HOSTS must be a nonempty comma-separated list of hostnames or IP addresses without schemes, ports, paths, wildcards, or empty entries. Put IPv6 addresses in brackets.");
  }
  if (issues.length) throw new ConfigurationError(issues);
  return { host, port, allowedHosts: [...new Set(allowedHosts)] };
}
