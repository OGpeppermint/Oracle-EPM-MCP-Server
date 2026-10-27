# Oracle EPM NSPB endpoint roadmap

Last reviewed: 2026-10-26

This file is the persistent inventory of Oracle Cloud EPM endpoints intentionally implemented or deferred in the MCP server. The scope is Oracle Planning/Planning Modules functionality applicable to NSPB plus shared Cloud EPM Platform and Infrastructure APIs that a Planning environment can use.

Primary Oracle references:

- [Planning REST APIs](https://docs.oracle.com/en/cloud/saas/enterprise-performance-management-common/prest/planning_rest_apis.html)
- [Cloud EPM Platform compatibility table](https://docs.oracle.com/en/cloud/saas/enterprise-performance-management-common/prest/all_rest_apis_table_all.html)
- [Cloud EPM REST API table of contents](https://docs.oracle.com/en/cloud/saas/enterprise-performance-management-common/prest/toc.htm)
- [Planning URL structure](https://docs.oracle.com/en/cloud/saas/enterprise-performance-management-common/prest/url_structure_33.html)

Oracle's current documented Planning version is v3. Never add or call an endpoint containing `/internal/`; Oracle explicitly states that internal path tokens are unsupported.

For detailed functionality, use cases, arguments, returns, visibility, and side effects for every active tool, see [tool-reference.md](tool-reference.md).

## Implemented now

| MCP tool | Oracle method and path | Purpose |
| --- | --- | --- |
| `get-epm-api-versions` | `GET /HyperionPlanning/rest/` | Discover supported Planning API versions. |
| `list-epm-applications` | `GET /HyperionPlanning/rest/v3/applications` | Discover applications visible to the service account. |
| `get-epm-application-summary` | `GET /HyperionPlanning/rest/v3/applications/{application}/summary` | Retrieve Oracle's AI-focused application summary. |
| `list-epm-plan-types` | `GET /HyperionPlanning/rest/v3/applications/{application}/plantypes` | Discover cubes/plan types. |
| `list-epm-dimensions` | `GET /HyperionPlanning/rest/v3/applications/{application}/plantypes/{plantype}/dimensions` | List and filter dimensions. |
| `get-epm-dimension` | `GET /HyperionPlanning/rest/v3/applications/{application}/plantypes/{plantype}/dimensions/{dimension}` | Retrieve a dimension hierarchy. |
| `get-epm-member` | `GET /HyperionPlanning/rest/v3/applications/{application}/dimensions/{dimension}/members/{member}` | Retrieve one member's properties. |
| `list-epm-job-definitions` | `GET /HyperionPlanning/rest/v3/applications/{application}/jobdefinitions` | Discover configured job types and names. |
| `get-epm-job-status` | `GET /HyperionPlanning/rest/v3/applications/{application}/jobs/{jobId}` | Poll asynchronous job status. |
| `get-epm-job-details` | `GET /HyperionPlanning/rest/v3/applications/{application}/jobs/{jobId}/details` | Diagnose import/export job processing. |
| `list-epm-substitution-variables` | `GET /HyperionPlanning/rest/v3/applications/{application}/substitutionvariables` | List application and plan-type scoped values. |
| `get-epm-substitution-variable` | `GET /HyperionPlanning/rest/v3/applications/{application}/substitutionvariables/{name}` | Retrieve one variable. |
| `export-epm-data-slice` | `POST /HyperionPlanning/rest/v3/applications/{application}/plantypes/{plantype}/exportdataslice` | Read a targeted JSON data grid. |
| `create-epm-rule` | `POST /interop/rest/v2/files/upload`; `PATCH /interop/rest/v2/files/upload/{id}`; `POST /interop/rest/v2/files/upload/{id}/complete`; `GET /interop/rest/v2/status/jobs/{id}`; `POST /interop/rest/v2/snapshots/import`; `GET /interop/rest/v2/status/migration/{id}` | Upload and import one CALC-only snapshot, polling until Oracle reports success or failure. Does not deploy or run a rule. |

The former command-center request `GET .../jobs?limit=12` was removed on 2026-08-12 after it produced HTTP 405 Method Not Allowed. Oracle documents the collection route for `POST` job execution and documents read-only status retrieval by identifier at `GET .../jobs/{jobId}`; the server now uses only the documented read-only job routes.

The Application Summary endpoint has a narrow compatibility fallback for NSPB tenants that return HTTP 406 to Oracle's documented `Accept: application/json`: the server retries that same read-only GET once with `Accept: */*` and accepts JSON or Markdown/plain text. This fallback does not apply to any other endpoint.

## Intentionally deferred: job and business-rule execution

Job submission was removed from the active server and UI on 2026-08-12. The read-only tools for job-definition discovery, status polling by job ID, and processing details remain implemented. Undocumented recent-job collection retrieval is also disabled.

| Deferred MCP tool | Oracle method and path | Reason deferred |
| --- | --- | --- |
| `execute-epm-job` | `POST /HyperionPlanning/rest/v3/applications/{application}/jobs` | Generic job submission can calculate, import, clear, refresh, restructure, export, or otherwise change application state. Restore only with reviewed job-specific schemas, authorization policy, explicit confirmation, and ambiguous-timeout handling. |
| `run-epm-business-rule` | Same jobs endpoint with `jobType=Rules` | Business rules can modify Planning data, and runtime prompts are customer-defined. Restore only with rule discovery/validation and deliberate execution controls. |

Neither deferred tool is registered with MCP or callable by any MCP client. `scripts/verify-mcp.mjs` asserts that both names remain absent.

## Deferred: next likely additions

These are useful but either write data/metadata, need specialized payload design, return binary content, or have narrower day-to-day usage.

### Data and metadata

- Clear Data Slice
- Import Data Slice
- Export Planning Data to a repository file
- Export Form Data
- Add Member (requires a dynamic-child-enabled parent and prior cube refresh)
- Retrieve Child Job Status Details
- List Library Documents
- Import/export/delete Library Documents through job execution and file APIs

### Variables

- Create or update application substitution variables
- Get plan-type substitution variables
- Get derived plan-type substitution variables
- Create/update plan-type substitution variables
- Delete individual or multiple application/plan-type substitution variables
- Get, set, create, update, and delete user-variable definitions and values

### Planning approvals

- List All Planning Units
- Get Available Planning Unit Actions
- Get Planning Unit Promotional Path
- Get Planning Unit History and Annotations
- Get Planning Unit Owner Photo
- Get Filters with All Possible Values
- Change Planning Unit Status

### Planning connections and settings

- View a Connection
- View All Connections
- Update a Connection
- Get User Preferences
- Get/Set Essbase Query Governor Execution Time
- Export Essbase Data
- Essbase Block Analysis Report

## Deferred operations sharing the job-execution endpoint

These documented Planning operations share the currently disabled job-execution endpoint. They are not available through this MCP server. Retain this inventory for future, strongly typed tools with operation-specific safety controls:

- Administration Mode
- Auto Predict
- Compact Cube
- Configure Oracle Guided Learning
- Clear Cube
- Cube Refresh
- Delete Library Documents
- Execute Application Diagnostics
- Export Audit
- Export Cell-Level Security
- Export Data
- Export Job Console
- Export Library Documents
- Export Metadata
- Export Security
- Export User Variable Values
- Export Valid Intersections
- Execute a Report Bursting Definition
- Import Cell-Level Security
- Import Data
- Import Exchange Rates
- Import Library Documents
- Import Metadata
- Import Security
- Import User Variable Values
- Import Valid Intersections
- Merge Data Slices
- Optimize Aggregation
- Plan Type Map
- Restructure Cube
- Rules
- Ruleset
- Sort Members

## Deferred: shared Cloud EPM Infrastructure APIs

All `/interop/rest/` APIs remain unexposed until their administrative risk and file-transfer behavior receive dedicated schemas and confirmation controls.

### Identity, users, groups, and access

- Add, update, list, and remove users
- Add/remove users in groups
- Assign/remove application and granular roles
- User, role assignment, invalid login, and assignment audit reports
- Available roles and team membership APIs

### Migration, files, snapshots, and backups

- Migration version discovery and status
- LCM import/export
- Upload, download, list, and delete files/folders
- Object Storage, SFTP, and cross-instance file copy
- Clone environment
- Application snapshot inspect, upload, download, copy, and rename
- Snapshot categories, artifacts, history, import options, repeated export, and artifact import
- List and restore backups; restore environment

### Service administration and security

- Service information, restart, recreate, and idle-session timeout
- Restricted data access
- Virus scan on upload
- Manual database-access permission
- Encryption keys
- Build version and daily maintenance window
- Run daily maintenance immediately
- Skip updates
- Email-domain allowlist
- Feedback and email
- Concurrent usage simulation

## Deferred: Data Integration and Reporting

All `/aif/rest/` Data Integration/Data Management routes and report-generation routes remain unexposed:

- API version discovery
- Pipeline details and execution
- Import/export data mappings
- Import/export Data Integration definitions
- Lock/unlock POV
- Run integrations, data rules, and batch rules
- Retrieve Data Integration job status
- Update Data Integration connections
- Generate Planning-compatible reports
- Retrieve report job status
- Execute Data Management reports

## Explicitly out of NSPB scope

Do not add product-specific APIs for Account Reconciliation, Enterprise Data Management, Enterprise Profitability and Cost Management, Profitability and Cost Management, Financial Consolidation and Close journals, Tax Reporting, Enterprise Journals, Supplemental Data Manager, or Task Manager unless the project scope is intentionally expanded beyond NSPB/Planning.

## Related roadmaps

- [Roadmap index](roadmap.md)
- [Authentication and authorization roadmap](authentication-roadmap.md)
- [Multi-tenancy roadmap](multi-tenancy-roadmap.md)
