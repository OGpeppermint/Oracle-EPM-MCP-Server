# Oracle EPM NSPB MCP tool reference

Last reviewed: 2026-08-12

The server exposes 14 active tools. The active surface is read-only: it can discover and inspect Planning resources, export a targeted data slice, and inspect existing jobs, but it cannot submit, rerun, cancel, or otherwise execute jobs or business rules.

## Common behavior

- Oracle credentials come only from the MCP server environment and are never accepted as tool arguments or returned in results.
- When an `application` argument is optional, omitting it uses `EPM_APPLICATION` from the server environment.
- The 13 Oracle API tools return model-readable text plus `structuredContent.data`, which contains Oracle's JSON response.
- `get-epm-connection-status` returns sanitized connection configuration and `checkedAt` directly in `structuredContent`.
- Oracle API, authentication, authorization, timeout, and network failures return an MCP error result with concise text; credentials are not exposed.
- All active tools are read-only in intent. `export-epm-data-slice` uses HTTP `POST` because Oracle's read API requires it, but it does not write Planning data.

## Tool summary

| Tool | Functionality | Visibility |
| --- | --- | --- |
| `get-epm-api-versions` | Discover supported Planning REST API versions and verify basic connectivity. | Model |
| `list-epm-applications` | List applications accessible to the configured service account. | Model |
| `get-epm-application-summary` | Retrieve Oracle's AI-focused structural application summary. | Model |
| `list-epm-plan-types` | List cubes or plan types in an application. | Model |
| `list-epm-dimensions` | List and filter dimensions for a selected plan type. | Model |
| `get-epm-dimension` | Retrieve a dimension hierarchy with selectable fields and aliases. | Model |
| `get-epm-member` | Retrieve detailed properties for one exact dimension member. | Model |
| `list-epm-job-definitions` | Discover configured job types and exact job names without executing them. | Model |
| `get-epm-job-status` | Read the current status of an existing Oracle job ID. | Model |
| `get-epm-job-details` | Read paginated processing messages for an existing import or export job. | Model |
| `list-epm-substitution-variables` | List application- and plan-type-scoped substitution variables. | Model |
| `get-epm-substitution-variable` | Retrieve one exact substitution variable. | Model |
| `export-epm-data-slice` | Read a targeted multidimensional Planning grid. | Model |
| `get-epm-connection-status` | Check sanitized local connection configuration without calling Oracle. | Model |

## Discovery and application context

### `get-epm-api-versions`

Returns the Planning REST API versions advertised by the configured Oracle EPM environment. Use it as a lightweight connectivity check, to identify the current supported API version, or to investigate behavior after an Oracle environment update.

- Arguments: none.
- Returns: Oracle's version collection, including any lifecycle status, latest-version indicators, and related links supplied by the service.
- Side effects: none.

### `list-epm-applications`

Lists Planning applications visible to the configured service account. Use it to discover the correct application name, validate account access, and inspect application characteristics such as type, storage, Unicode, hybrid mode, administration mode, theme, and related metadata.

- Arguments: none. This tool does not require `EPM_APPLICATION` because its purpose is application discovery.
- Returns: Oracle's application collection and related links.
- Side effects: none.
- Access note: Oracle documents Service Administrator as the required role.

### `get-epm-application-summary`

Retrieves Oracle's AI-focused summary of a Planning application. It provides broad structural context—such as cubes, dimensions, hierarchies, forms, rules, and variables—without requiring a separate request for every artifact. Use it near the beginning of an analysis or discovery workflow.

- `application` (optional string): application name; defaults to `EPM_APPLICATION`.
- `fullHierarchyThreshold` (optional non-negative integer): include full hierarchies for dimensions at or below this member count. Oracle's documented default is 100.
- `aliasTableName` (optional string): alias table used for returned aliases, such as `Default`.
- `dimensionsToInclude` (optional string): comma-separated dimension allowlist, such as `Account,Entity,Period`.
- Returns: Oracle's application-summary payload.
- Side effects: none.
- Stability note: Oracle describes this AI-oriented response as subject to change between releases, so consumers should not treat it as a fixed integration contract.
- Compatibility behavior: the server omits `aliasTableName=Default` because Default is Oracle's documented default. It first requests `application/json`; if this endpoint alone returns HTTP 406, it retries the same idempotent GET once with `Accept: */*` to accommodate tenant rollout differences. Successful JSON and Markdown/plain-text representations are supported; HTML success responses are rejected.

## Plan types and metadata

### `list-epm-plan-types`

Lists the plan types or cubes in a Planning application. Use it before dimension, hierarchy, or data-slice requests to discover valid cube names and distinguish standard/BSO and ASO cubes.

- `application` (optional string): application name; defaults to `EPM_APPLICATION`.
- Returns: plan-type names and identifiers, cube names and types, dimension counts, and related links supplied by Oracle.
- Side effects: none.
- Access note: Oracle documents Any Role as sufficient.

### `list-epm-dimensions`

Lists dimensions associated with one plan type. Use it to discover valid dimension names and types before retrieving a hierarchy, looking up a member, or composing a grid definition.

- `application` (optional string): application name; defaults to `EPM_APPLICATION`.
- `planType` (required string): exact plan type or cube name, such as `Plan1`.
- `q` (optional string): Oracle MongoDB-style JSON filter string, passed as text; for example `{"dimType":{"$ne":"Attribute Dimension"}}`.
- `offset` (optional non-negative integer): zero-based first result index.
- `limit` (optional integer of `-1` or greater): maximum records; Oracle documents `0` or `-1` as all remaining records.
- `fields` (optional string): comma-separated response fields, such as `id,name,level,dimType,objectType`.
- Returns: dimension items, pagination information, total results, and links.
- Side effects: none.

### `get-epm-dimension`

Retrieves one dimension hierarchy within a selected plan type. Use it when hierarchy context, paths, aliases, or child relationships are needed. Large dimensions can produce large responses, so request only necessary fields.

- `application` (optional string): application name; defaults to `EPM_APPLICATION`.
- `planType` (required string): exact plan type or cube name.
- `dimension` (required string): exact dimension name, such as `Entity` or `Account`.
- `fields` (optional string): comma-separated fields such as `id,name,alias,path,children`.
- `aliasTableName` (optional string): alias table used for aliases, such as `Default`.
- Returns: Oracle's dimension hierarchy payload.
- Side effects: none.

### `get-epm-member`

Retrieves detailed properties for one exact member in one dimension. Use it for focused validation when the dimension and member names are already known instead of loading a complete hierarchy.

- `application` (optional string): application name; defaults to `EPM_APPLICATION`.
- `dimension` (required string): exact dimension name containing the member.
- `member` (required string): exact member name; the server URL-encodes spaces and reserved path characters.
- Returns: member properties supplied by Oracle, potentially including name, parent, description, data type, storage, dimension, object type, two-pass setting, children information, and links.
- Side effects: none.
- Access note: Oracle documents Service Administrator as the required role.

## Substitution variables

### `list-epm-substitution-variables`

Lists substitution variables visible in an application across application and plan-type scopes. Use it to resolve environment-specific values such as the current year, period, scenario, or version before building reports and data queries. Identically named variables may have different values at application and cube scopes.

- `application` (optional string): application name; defaults to `EPM_APPLICATION`.
- Returns: variables with their names, values, plan-type scopes, and links supplied by Oracle.
- Side effects: none.
- Access note: Oracle documents Any Role as sufficient.

### `get-epm-substitution-variable`

Retrieves one named application substitution variable. Use it when the exact name is known and a focused result is preferable to listing every variable.

- `application` (optional string): application name; defaults to `EPM_APPLICATION`.
- `name` (required string): exact variable name without a leading ampersand; for example `CurrYear`.
- Returns: the variable name, resolved value, plan-type scope, and related links supplied by Oracle.
- Side effects: none.
- Access note: Oracle documents Any Role as sufficient.

## Planning data

### `export-epm-data-slice`

Reads a precisely defined multidimensional region from a Planning cube and returns Oracle's JSON grid. Use it for targeted analysis after validating plan type, dimension, and member names. Keep the grid narrow to avoid large Oracle responses and excessive model context.

- `application` (optional string): application name; defaults to `EPM_APPLICATION`.
- `planType` (required string): exact plan type or cube name.
- `gridDefinition` (required object): Oracle Planning grid definition containing POV, columns, rows, dimension names, and member selections.
- `exportPlanningData` (optional boolean): when true, request supporting detail and cell notes where available; defaults to false.
- Returns: Oracle's JSON data grid, including POV, columns, rows, cell values, and optional Planning details.
- Side effects: none. Oracle implements this read operation with HTTP `POST`.

## Read-only job inspection

### `list-epm-job-definitions`

Lists jobs configured in the application, optionally filtered by job type. Use it to inventory exact case-sensitive job names and types for auditing, documentation, or workflows executed outside this MCP server. It does not execute a definition.

- `application` (optional string): application name; defaults to `EPM_APPLICATION`.
- `jobType` (optional string): exact Oracle job-type filter, such as `RULES`, `RULESET`, `IMPORT_DATA`, or `CUBE_REFRESH`.
- Returns: configured job definitions containing job type and job name.
- Side effects: none.
- Access note: Oracle documents Service Administrator as the required role.

### `get-epm-job-status`

Reads one existing Planning job using its Oracle-assigned identifier. Use it to determine whether externally submitted work is processing, completed, failed, cancelled, pending cancellation, or rejected.

- `application` (optional string): application name; defaults to `EPM_APPLICATION`.
- `jobId` (required string or non-negative integer): existing Oracle job identifier.
- Returns: Oracle's status code, descriptive status, job name, details, detailed status, and related links.
- Side effects: none; safe to poll.

### `get-epm-job-details`

Retrieves detailed processing records for an existing Planning import or export job. Use it after checking job status to diagnose rejected data, metadata, warnings, and informational records.

- `application` (optional string): application name; defaults to `EPM_APPLICATION`.
- `jobId` (required string or non-negative integer): parent Oracle job identifier.
- `messageType` (optional enum): `ERROR`, `WARNING`, or `INFO`.
- `offset` (optional non-negative integer): zero-based result offset.
- `limit` (optional positive integer): maximum detailed records; Oracle's documented default is 25.
- Returns: Oracle's detailed processing records, pagination information, and child-job links where supplied.
- Side effects: none.
- Scope note: Oracle documents this details endpoint for `IMPORT_DATA`, `EXPORT_DATA`, `IMPORT_METADATA`, and `EXPORT_METADATA` jobs.

## Connection status

### `get-epm-connection-status`

Checks local server configuration without calling Oracle. Takes no arguments and returns sanitized `connection` and ISO 8601 `checkedAt` fields. Missing variables appear in `connection.missing`. Safe to retry and read-only.

The Command Center GUI, maintained in a separate repository, calls these standard MCP tools over HTTP. The MCP server exposes no UI resources or app-only tools.

## Intentionally unavailable execution tools

`execute-epm-job` and `run-epm-business-rule` are not active MCP tools. Their previous names, Oracle route, risks, and the job types that route can cover are preserved in [endpoint-roadmap.md](endpoint-roadmap.md). The verification suite fails if either name is accidentally exposed.
