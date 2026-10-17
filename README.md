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
| `EPM_APPLICATION` | Planning application name, such as `NSPB` |
| `PORT` | Optional HTTP port; defaults to `3001` |
| `HOST` | HTTP listening address; defaults to `127.0.0.1` |
| `MCP_ALLOWED_HOSTS` | Comma-separated permitted HTTP hostnames; defaults to `localhost,127.0.0.1,[::1]` |

For a container or remote deployment, set `HOST=0.0.0.0` and set `MCP_ALLOWED_HOSTS` to the hostnames used to reach the service, for example `mcp.example.com,localhost,127.0.0.1`. Allowlist entries contain no scheme, port, or path; IPv6 entries use brackets. Configure the reverse proxy and health probes to send an allowed Host header. The allowlist applies to both `/mcp` and `/health`.

`GET /health` returns HTTP 200 with `{"status":"ok"}` when the HTTP service is running. This liveness check does not contact Oracle or validate Oracle credentials. HTTP settings do not apply to stdio mode. Incoming MCP authentication and restricted browser CORS remain planned in the [roadmap](docs/roadmap.md).

## API coverage and validation

The server exposes 14 read-only tools. See [the tool reference](docs/tool-reference.md) for arguments, results, and access notes, and [the roadmap](docs/roadmap.md) for deferred work.

Run `npm run check` for TypeScript validation and `npm run verify:mcp` to build and verify tool discovery, connection status, disabled execution tools, and absence of GUI resources over a real MCP stdio connection.

Run `npm run verify:http` to build and check the health endpoint, allowed and rejected HTTP hostnames, and MCP HTTP connectivity on a temporary port. This check uses no Oracle API calls and is included in `npm run release:check`.

## License and release checks

This software is licensed under the GNU General Public License, version 3 only (`GPL-3.0-only`). See [LICENSE.txt](LICENSE.txt) for the full terms. Third-party dependencies retain their own licenses and notices in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and `licenses/`. Generate production dependency notices with `npm run notices` and run `npm run release:check` before packaging. Install distributable runtime dependencies with `npm ci --omit=dev`. Development dependencies and GUI assets do not belong in the server distribution.
