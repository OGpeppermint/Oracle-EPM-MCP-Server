# Oracle EPM NSPB MCP Server

Read-only MCP server for Oracle EPM Planning / NSPB. It exposes application discovery, metadata exploration, substitution variables, targeted data slices, existing-job inspection, and sanitized connection status. Job and business-rule execution remain disabled.

## Setup

1. Run `npm install`.
2. Copy `.env.example` to `.env` and provide the Oracle EPM service account and application name.
3. Load the variables into your environment; the server does not load `.env` automatically.
4. Run `npm run build` then `npm start`, or `npm run dev` during development.
5. Connect any MCP host to `http://127.0.0.1:3001/mcp`. For stdio, use `npm run start:stdio`.

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

## API coverage and validation

The server exposes 14 read-only tools. See [the tool reference](docs/tool-reference.md) for arguments, results, and access notes, and [the roadmap](docs/roadmap.md) for deferred work.

Run `npm run check` for TypeScript validation and `npm run verify:mcp` to build and verify tool discovery, connection status, disabled execution tools, and absence of GUI resources over a real MCP stdio connection.

## Commercial release compliance

`LICENSE.txt` contains a proprietary-license template. Replace `[LEGAL OWNER NAME]` and have the customer license terms reviewed before distribution. Generate production dependency notices with `npm run notices` and run `npm run release:check` before packaging. Install distributable runtime dependencies with `npm ci --omit=dev`. Development dependencies and GUI assets do not belong in the server distribution.
