# Oracle EPM NSPB MCP Server

Read-only MCP server for Oracle EPM Planning / NSPB. It exposes application discovery, metadata exploration, substitution variables, targeted data slices, existing-job inspection, and sanitized connection status. Job and business-rule execution remain disabled.

## Setup

1. Install Node.js 22.9 or newer, then run `npm install`.
2. Copy `.env.example` to `.env` and provide the Oracle EPM service account and application name.
3. Run `npm run build` then `npm start`, or `npm run dev` during development.
4. Connect any MCP host to `http://127.0.0.1:3001/mcp`. For stdio, use `npm run start:stdio`.

All npm server startup commands load the project-root `.env` automatically. Existing environment variables take precedence, and the file is optional so deployments can supply configuration through the environment. Restart the server after editing `.env`.

When an MCP client launches Node directly, use `node --env-file-if-exists=/absolute/path/to/.env /absolute/path/to/dist/main.js --stdio`, or provide the variables through the client's environment settings.

Oracle credentials are used only by the server.

## Separate GUI project

The Command Center GUI is maintained in the separate `NSPB-Command-Center` repository. It connects to this server through standard MCP HTTP tool calls and has its own installation, build, and release workflow. No Command Center checkout is required to build or run this server.

## Repository layout

- `src/main.ts` starts the HTTP or stdio transport.
- `src/config.ts` validates startup configuration without exposing credential values.
- `src/shutdown.ts` handles HTTP shutdown signals, connection draining, and resource cleanup.
- `src/logging.ts` provides JSON logging and request correlation.
- `src/server.ts` defines the MCP tools and Oracle EPM requests.
- `scripts/` contains MCP verification and dependency-notice tooling.
- `docs/` contains the tool reference and server roadmaps.
- `licenses/` and `THIRD_PARTY_NOTICES.md` contain server dependency license material.
- `dist/` contains generated server output and is ignored by Git.

## Environment variables

| Name | Purpose |
| --- | --- |
| `EPM_BASE_URL` | Oracle Cloud EPM origin, without a trailing slash |
| `EPM_USERNAME` | Service-account username |
| `EPM_PASSWORD` | Service-account password |
| `EPM_APPLICATION` | Optional default Planning application name, such as `NSPB`; tools can supply an explicit application |
| `PORT` | Optional HTTP port; defaults to `3001` |
| `HOST` | HTTP listening address; defaults to `127.0.0.1` |
| `MCP_ALLOWED_HOSTS` | Comma-separated permitted HTTP hostnames; defaults to `localhost,127.0.0.1,[::1]` |
| `MCP_ALLOWED_ORIGINS` | Comma-separated permitted HTTP/HTTPS browser origins; unset or empty allows no browser origins |
| `SHUTDOWN_TIMEOUT_MS` | HTTP shutdown deadline in milliseconds; defaults to `25000` |

For a container or remote deployment, set `HOST=0.0.0.0` and set `MCP_ALLOWED_HOSTS` to the hostnames used to reach the service, for example `mcp.example.com,localhost,127.0.0.1`. Allowlist entries contain no scheme, port, or path; IPv6 entries use brackets. Configure the reverse proxy and health probes to send an allowed Host header. The allowlist applies to both `/mcp` and `/health`.

Both HTTP and stdio startup require a nonblank `EPM_BASE_URL`, `EPM_USERNAME`, and `EPM_PASSWORD`. The URL must be an HTTPS origin with no embedded credentials, path, query, or fragment; an optional trailing slash is normalized away. Invalid configuration exits with code 1 and an error listing setting names and expected formats, without echoing supplied values. Startup validation does not contact Oracle or verify credentials.

`EPM_APPLICATION` can be omitted for application discovery. Application-specific tools then require an explicit `application` argument. Connection status considers the three required Oracle settings, independently of whether a default application is set.

In HTTP mode, `HOST` must be a hostname or unbracketed IP address, `PORT` must be an integer from 0 to 65535 (0 selects a temporary port), and `MCP_ALLOWED_HOSTS` must contain valid hostnames or IP addresses with no empty entries or wildcards. Omit HTTP settings to use their defaults. Stdio mode ignores HTTP-only settings.

Set `MCP_ALLOWED_ORIGINS` to the origins of the browser pages that call this service, such as the Command Center website. This setting includes the scheme and optional port, unlike the server hostname allowlist. For example:

```dotenv
MCP_ALLOWED_ORIGINS=http://localhost:5173,https://your-command-center.example.com
```

Replace the example with your actual browser origins. Entries cannot contain credentials, paths, queries, fragments, or wildcards; a trailing slash and default port are normalized away. Origins match exactly, so different schemes, subdomains, and non-default ports require separate entries. Restart the server after changing configuration. On Render, set this variable in the service's Environment settings.

Requests with an unapproved `Origin` header (including `Origin: null`) receive HTTP 403 before the MCP handler runs. An unset or empty list rejects all Origin-bearing requests. Native MCP clients and health probes without an Origin header continue to work. Allowed browser requests receive origin-specific CORS headers; preflight supports MCP methods and headers, and browsers can read session and authentication-challenge response headers. Cookie-based CORS credentials are not enabled. These controls apply to `/mcp` and `/health` and do not authenticate callers.

`GET /health` returns HTTP 200 with `{"status":"ok"}` when the HTTP service is running. This liveness check does not contact Oracle or validate Oracle credentials. HTTP settings do not apply to stdio mode. Incoming MCP authentication remains planned in the [roadmap](docs/roadmap.md).

## HTTP shutdown

`SIGTERM` (used by Render during deployment) and `SIGINT` (Ctrl+C) initiate graceful HTTP shutdown. The server stops accepting connections and rejects any new requests reaching existing connections with HTTP 503 and `Connection: close`, including health probes. Long-lived notification streams close immediately; active tool requests can finish within the shutdown window. Idle connections are closed as responses finish, MCP servers and their transports are cleaned up once, and abandoned Oracle reads are cancelled after HTTP requests drain. Repeated shutdown signals reuse the same cleanup operation.

After successful cleanup the process exits normally. If the deadline expires, remaining HTTP connections are forcibly closed and the process exits with code 1; cleanup failures also produce a nonzero exit status. `SHUTDOWN_TIMEOUT_MS` must be an integer between 1 and 2147483647. Keep it shorter than the hosting platform's termination limit. The default is 25 seconds, below [Render's default 30-second shutdown delay](https://render.com/docs/deploys#graceful-shutdown). This lifecycle applies to HTTP mode; stdio retains its existing transport behavior.

## Logs and error references

Application logs are JSON lines on stderr in both HTTP and stdio modes. Stdio stdout contains only MCP protocol messages. Events include startup and shutdown, HTTP request completion, tool completion, and safe failures. Logs contain timestamps, severity, operation names, HTTP status where available, durations, and request IDs. HTTP routes are recorded as `/mcp`, `/health`, or `other`; query strings, request bodies, arguments, headers, Oracle response bodies, raw exception messages, and stack traces are excluded.

Every HTTP response includes a server-generated UUID in `X-Request-Id`, including hostname/origin rejections and JSON parser errors. Incoming request ID headers are not reused or logged. Tool results include `_meta.requestId`; tool failures also include `_meta.errorCode` and the request ID in their text. HTTP tool results share the HTTP response's ID, while stdio tool calls receive separate IDs. Browser clients can read `X-Request-Id` through CORS.

For example, an Oracle authentication failure produces a log shaped like:

```json
{"timestamp":"2026-10-17T00:00:00.000Z","level":"error","event":"mcp.tool.failed","requestId":"21573b50-78b0-427f-8ade-e35b315c4192","operation":"Plan type listing","errorCode":"EPM_HTTP_ERROR","status":401,"durationMs":25}
```

Oracle failures return safe HTTP-status guidance or stable codes such as `EPM_NETWORK_ERROR`, `EPM_TIMEOUT`, `EPM_ABORTED`, and `EPM_RESPONSE_FORMAT`. Invalid JSON request bodies receive a generic HTTP 400 response. Connection status masks usernames of every format, retaining at most two initial characters and masking short names completely. Successful Oracle tool data remains intact and is not written to application logs. Use a returned request ID to find matching events in Render's service logs.

## API coverage and validation

The server exposes 14 read-only tools. See [the tool reference](docs/tool-reference.md) for arguments, results, and access notes, and [the roadmap](docs/roadmap.md) for deferred work.

Run `npm run check` for TypeScript validation and `npm run verify:mcp` to build and verify tool discovery, connection status, disabled execution tools, and absence of GUI resources over a real MCP stdio connection.

Run `npm run verify:http` to build and check the health endpoint, allowed and rejected HTTP hostnames and browser origins, preflight responses, browser MCP headers, and MCP HTTP connectivity on temporary ports. It covers both an explicit browser allowlist and an empty list. This check uses no Oracle API calls and is included in `npm run release:check`.

Run `npm run verify:config` to build and check startup validation, safe error reporting, HTTP configuration, and stdio discovery without a default application. It is also included in `npm run release:check`. Verification uses synthetic Oracle settings and makes no Oracle API calls.

Run `npm run verify:shutdown` to check idle shutdown, active MCP request draining, repeated signals, forced termination at the deadline, abandoned Oracle read cancellation, and resource cleanup. Tests use a mocked Oracle response and make no Oracle API calls. On Windows, a test-only IPC bridge emits the signal events because terminating a Windows child process does not deliver POSIX signals; on POSIX systems the tests send actual signals. Shutdown checks are included in `npm run release:check`.

Run `npm run verify:logging` to check concurrent HTTP request correlation, sanitized Oracle errors, parser errors and early rejections, username masking, clean stdio communication, and successful JSON/Markdown tool results. Synthetic secrets and mocked Oracle responses verify that private values do not enter error results or application logs. These checks are included in `npm run release:check`.

## License and release checks

This software is licensed under the GNU General Public License, version 3 only (`GPL-3.0-only`). See [LICENSE.txt](LICENSE.txt) for the full terms. Third-party dependencies retain their own licenses and notices in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and `licenses/`. Generate production dependency notices with `npm run notices` and run `npm run release:check` before packaging. Install distributable runtime dependencies with `npm ci --omit=dev`. Development dependencies and GUI assets do not belong in the server distribution.
