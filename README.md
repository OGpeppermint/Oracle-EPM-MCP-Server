# Oracle EPM NSPB MCP App

An interactive, read-only MCP App for Oracle EPM Planning / NSPB. Its command center covers application discovery, metadata exploration, substitution variables, targeted data slices, job-definition discovery, and inspection of existing asynchronous jobs. Job and business-rule execution are intentionally disabled.

## Setup

1. Run `npm install`.
2. Copy `.env.example` to `.env` and provide an Oracle EPM service account and application name.
3. Load the variables into your environment. The server intentionally does not read `.env` automatically.
4. Run `npm run build` and then `npm start`, or use `npm run dev` while developing.
5. Connect an MCP Apps-capable host to `http://127.0.0.1:3001/mcp`. For stdio, use `npm run start:stdio`.

Open the `open-epm-command-center` tool in the host. Credentials are used only by the server and are never returned to the UI or model.

## Command Center UI

- **Overview** checks local connection configuration, discovers API versions and accessible applications, and loads an AI-focused application summary.
- **Metadata** explores plan types, dimensions, hierarchies, members, and substitution variables.
- **Data** exports a targeted, read-only Planning grid from a selected plan type.
- **Jobs** discovers configured job definitions and reads status or error details for an existing job ID. It cannot submit, rerun, or cancel jobs.

Every API response is shown in the structured JSON result panel. No active MCP tool executes jobs or business rules, and the UI contains no execution controls.

## Environment variables

| Name | Purpose |
| --- | --- |
| `EPM_BASE_URL` | Oracle Cloud EPM origin, without a trailing slash |
| `EPM_USERNAME` | Service-account username |
| `EPM_PASSWORD` | Password (or identity-domain-qualified password where required) |
| `EPM_APPLICATION` | Planning application name, such as `NSPB` |
| `PORT` | Optional HTTP port; defaults to `3001` |

The integration uses documented read-only Oracle Planning REST v3 job endpoints for definitions, status by job ID, and processing details. Configure the service account with only the least privilege required to inspect those resources.

## Implemented API coverage

The server currently exposes 15 tools and prioritizes high-frequency read-only NSPB workflows: API/application discovery, AI application summaries, plan types, dimensions, dimension hierarchies, members, job definitions, job status/details, substitution-variable reads, targeted data-slice export, and the command-center UI controls.

See [docs/tool-reference.md](docs/tool-reference.md) for every active tool's functionality, common use cases, arguments, returns, visibility, access notes, and side effects.

See the [roadmap index](docs/roadmap.md) for the separate endpoint, authentication/authorization, and multi-tenancy roadmaps. The [endpoint roadmap](docs/endpoint-roadmap.md) preserves the exact implemented routes, deferred job/rule execution tools and job types, and the deferred Oracle API inventory.

Run `npm run verify:mcp` to rebuild the app and verify tool discovery, confirm that execution tools remain disabled, and validate app visibility, UI-resource linkage, MIME type, and the four command-center workspaces over an actual MCP stdio session.

## Commercial release compliance

- [`LICENSE.txt`](LICENSE.txt) contains a proprietary-license notice template. Replace `[LEGAL OWNER NAME]` and have the customer license terms reviewed before distribution.
- [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) contains exact production dependency licenses and notices and is generated with `npm run notices`.
- [`licenses/README.md`](licenses/README.md) explains the notice scope and production-only packaging boundary.
- Run `npm run release:check` before packaging every release.
- Install distributable runtime dependencies with `npm ci --omit=dev`; do not ship development dependencies or build layers in the production image.
