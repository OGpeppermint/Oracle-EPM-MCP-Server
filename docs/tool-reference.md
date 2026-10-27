# Oracle EPM NSPB MCP tool reference

Last reviewed: 2026-10-26

The server exposes 15 active tools: 14 read-only tools plus `create-epm-rule`, which imports one Calculation Manager rule. Job and business-rule execution remain unavailable.

## Common behavior

- Oracle credentials come only from the MCP server environment and are never accepted as tool arguments or returned in results.
- HTTP and stdio startup require a valid HTTPS Oracle origin and nonblank username and password. Invalid configuration exits before a transport opens; startup validation makes no Oracle request. `EPM_APPLICATION` remains optional.
- When an `application` argument is optional, omitting it uses `EPM_APPLICATION` from the server environment.
- The 13 read-only Oracle API tools return model-readable text plus `structuredContent.data`, which contains Oracle's JSON response.
- `get-epm-connection-status` returns sanitized connection configuration and `checkedAt` directly in `structuredContent`.
- Oracle API, authentication, authorization, timeout, and network failures return an MCP error result with safe text and a request ID. Raw Oracle error bodies, URLs, headers, parser exceptions, and stack traces are excluded.
- Tool results include `_meta.requestId`; failures also include `_meta.errorCode`. HTTP calls share the ID returned in the `X-Request-Id` response header; stdio calls receive independent IDs. Match IDs to the JSON application logs on stderr.
- `create-epm-rule` writes a rule through Oracle's snapshot upload and import APIs. All other active tools are read-only in intent. `export-epm-data-slice` uses HTTP `POST` because Oracle's read API requires it, but it does not write Planning data.
- Oracle operations share a configurable 30-second total deadline across attempts and retry waits. Eligible GET requests retry transient network failures and HTTP 429/502/503/504 up to twice, with exponential backoff, jitter, and respect for `Retry-After`. POST exports, authentication/permission errors, invalid responses, and size-limit failures are not retried.
- Oracle response bodies are limited to 5 MiB by default, counted as decoded bytes while downloading. An oversized response is cancelled and returned as `EPM_RESPONSE_TOO_LARGE`, without partial data. Use pagination, field selection, or a narrower data slice. See the [configuration reference](../README.md#oracle-request-limits-and-retries) for settings and bounds.

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
| `create-epm-rule` | Build, upload, and import one Calculation Manager rule snapshot; wait for the import result. | Model |
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
- Compatibility behavior: the server omits `aliasTableName=Default` because Default is Oracle's documented default. It first requests `application/json`; if this endpoint alone returns HTTP 406, it retries the same idempotent GET once with `Accept: */*` to accommodate tenant rollout differences. The fallback shares the operation deadline and transient retry budget, remains available with `EPM_MAX_RETRIES=0`, and does not loop on another 406. Successful JSON and Markdown/plain-text representations are supported; HTML success responses are rejected.

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

## Rule creation

### `create-epm-rule`

Creates one Calculation Manager rule in a single MCP call. The server validates the supplied rule, builds an LCM ZIP with `CALC-Calculation Manager` authoring and `HP-{application}` Planning rule artifacts in memory, uploads it to Oracle EPM, imports it, and polls asynchronous extraction/import jobs before returning success. The Planning artifact allows the import to restore the rule to Planning. The tool does not execute the rule. Use a new rule name for create-only behavior: Oracle's import may affect a same-named artifact.

- `application` (optional string): target application; defaults to `EPM_APPLICATION`.
- `planType` (required string): exact cube/plan-type name.
- `name` (required string): rule name.
- `script` (required string): Calc Script or Groovy source text.
- `language` (optional enum): `calcscript` (default) or `groovy`.
- `description` (optional string): rule description.
- `rtps` (optional array): definitions of run-time prompts referenced by the script. Each item needs `name` and `type`; supported types are `str`, `num`, `percent`, `member`, `members`, `dimension`, `cellref`, `str_as_num`, `date_as_num`, `member_range`, and `integer`. Optional fields cover scope, dimension, defaults, labels, validation, limits, and cell-reference prompts. Supply actual definitions rather than only prompt names.
- `dependencies` (optional array): explicit Script or Template bodies used by the rule. Each item needs `kind` (`script` or `template`), `name`, and `script`; `language` and `description` are optional. These artifacts are imported with the rule.
- Reference syntax: Calc Script RTPs use `{PromptName}`. Script/Template references use `%Script(...)` or `%Template(...)` and need matching `dependencies`. Groovy RTP declarations use a `/*RTPS: {PromptName}*/` header in the first 25 lines. Missing or unused RTP definitions and unresolved dependency references fail snapshot validation before any Oracle request.
- Returns: `structuredContent.data` with `stage: "import_completed"`, application, cube, rule name, generated `snapshotName`, available Oracle job IDs, snapshot SHA-256, and packaged artifact list. This confirms Oracle reported a successful snapshot import. The tool does not independently query the rule's deployment status or execute it.
- Failure: an MCP error with `structuredContent.error` containing `code`, `stage` (`snapshot`, `upload`, `extraction`, or `import`), available job IDs, and `outcomeUncertain`. A timeout or network error after upload may leave work in progress; inspect the returned job ID before retrying.

The snapshot builder runs in TypeScript within the server process. `EPM_CREATE_RULE_POLL_TIMEOUT_MS` defaults to five minutes. The builder has no local-pod mode and makes no Oracle request; the Oracle client performs upload and import using the server's existing credentials.

## Connection status

### `get-epm-connection-status`

Checks local server configuration without calling Oracle. Takes no arguments and returns sanitized `connection` and ISO 8601 `checkedAt` fields. Missing variables appear in `connection.missing`. Safe to retry and read-only.

`connection.configured` and `connection.missing` cover `EPM_BASE_URL`, `EPM_USERNAME`, and `EPM_PASSWORD`. An absent default `EPM_APPLICATION` does not make the connection unconfigured; application-specific calls can pass an explicit application.

The username is masked consistently for email, domain-qualified, and plain service accounts: at most two initial characters are retained, followed by `****`; accounts of one or two characters return `****`.

The Command Center GUI, maintained in a separate repository, calls these standard MCP tools over HTTP. The MCP server exposes no UI resources or app-only tools.

## Intentionally unavailable execution tools

`execute-epm-job` and `run-epm-business-rule` are not active MCP tools. Their previous names, Oracle route, risks, and the job types that route can cover are preserved in [endpoint-roadmap.md](endpoint-roadmap.md). The verification suite fails if either name is accidentally exposed.
