# Multi-tenancy roadmap

Last reviewed: 2026-08-12

This roadmap covers the transition from a single Oracle environment to dedicated or pooled commercial tenant deployments. Authentication prerequisites are in [authentication-roadmap.md](authentication-roadmap.md).

## Phase 1: dependency-injected tenant context

Replace global Oracle environment configuration with an immutable, verified request context:

```text
createServer({ tenant, user, scopes, oracleConnection })
epmRequest(oracleConnection, path, options)
```

Establish the context before tool dispatch. Include a stable tenant ID, verified subject and issuer, scopes and roles, approved Oracle origin and applications, credential/token-provider reference, and correlation/audit IDs. Validate any `application` argument against `tenant.allowedApplications`.

## Phase 2: tenant registry and managed secrets

| Record | Responsibility |
| --- | --- |
| `Tenant` | ID, status, display name, routing key, allowed applications, limits, and lifecycle timestamps. |
| `IdentityBinding` | Accepted issuer and audience, mapping rules, scopes/roles, and status. |
| `OracleConnection` | Validated EPM origin, authentication mode, non-secret metadata, and secret references. |
| `AuditEvent` | Tenant, subject, tool, target, outcome, timing, correlation, and redacted error class. |

Use OCI Vault or equivalent for credentials, refresh tokens, client secrets, and encryption keys. Store only opaque secret references in the application database. Keep tenant administration in a separate control plane; ordinary MCP tools and UI actions must not change tenants, issuers, Oracle origins, or secrets.

## Phase 3: tenant routing and identity models

Support one or both commercial identity models:

1. **Vendor-managed Identity Domain with customer federation.**
2. **Customer-owned IDCS/OCI IAM Identity Domains.**

For customer-owned domains, prefer hostnames such as `https://customer-a.mcp.example.com/mcp`. Resolve an allowlisted hostname first, then validate only against that tenant's exact issuer, audience, JWKS policy, and bindings. Never select a tenant from an unverified JWT claim, body field, query parameter, or tool argument.

Provision Oracle origins administratively. Enforce HTTPS and strict hostname, port, redirect, and DNS/IP rules. Revalidate redirects and resolved destinations; block loopback, link-local, metadata-service, private, and other prohibited networks unless explicitly isolated and required.

## Phase 4: isolation, reliability, and audit

Include tenant identity in every cache and state key, including:

- Oracle tokens and refresh coordination.
- EPM metadata and data caches.
- Rate and concurrency limits, queues, circuit breakers, and retry budgets.
- Idempotency and asynchronous job-status records.
- Client-visible session state and tool results. External clients own their UI preferences and state.
- Metrics, traces, logs, diagnostics, and exports.

Apply per-tenant quotas and backpressure. Bound pagination and response sizes. Redact Planning values, credentials, tokens, and personal data from logs. Encrypt traffic and stored tenant data. Define suspension, revocation, export, retention, and deletion. Make support access approved, time-limited, attributable, and auditable. Errors and telemetry must not expose other tenants.

## Phase 5: onboarding and lifecycle

1. Create the tenant as pending.
2. Verify domain ownership and the commercial administrator.
3. Validate issuer, audience, scopes, redirects, and MCP client compatibility.
4. Validate the administratively supplied Oracle EPM origin.
5. Establish credentials or complete Oracle OAuth consent.
6. Test version discovery and application listing.
7. Approve specific Planning applications, roles, quotas, retention, and residency settings.
8. Run isolation/connectivity checks and activate the tenant.

Support suspension, reauthorization, secret rotation, issuer/client migration, customer export, retention expiry, secure deletion, and final audit evidence.

## Phase 6: multi-tenant release gate

- Tenant A cannot reach Tenant B through tools, UI, caches, job IDs, errors, or retries.
- Hostname, issuer, audience, subject, scope, status, and application mismatches fail closed.
- Forged arguments or claims cannot alter routing.
- Cache, limit, token-refresh, and circuit-breaker state cannot bleed across tenants.
- Redirects and attacker-controlled URLs cannot reach prohibited networks.
- Logs, traces, metrics, exports, and support tools preserve isolation.
- Suspension and revocation take effect within documented bounds.
- Key rotation and token-refresh races remain available and isolated.
- MCP hosts and external clients never receive server-side Oracle credentials, Oracle tokens, or tenant secrets.

Use at least two deliberately similar tenants in unit, integration, and end-to-end negative tests. Require a deployment-level penetration test before pooled SaaS release.

## Recommended commercial progression

Start with a dedicated deployment per customer, or a shared control plane with a dedicated tenant data plane. Promote a pooled SaaS model only after tenant context, registry, vault, hostname-first routing, identity isolation, tenant-keyed state, quotas, auditing, and cross-tenant tests are complete.

Suggested order:

1. Complete single-tenant inbound OAuth.
2. Inject Oracle configuration through verified request context.
3. Add registry, OCI Vault, and audit records.
4. Add tenant-specific hostname routing.
5. Add the selected Identity Domain onboarding model(s).
6. Add tenant-specific Oracle OAuth.
7. Add isolation tests, SSRF defenses, quotas, and operational workflows.
8. Complete independent security and shared-SaaS readiness reviews.

## Product decisions still required

- Dedicated, hybrid, or pooled deployment model.
- Vendor-managed, customer-owned, or both Identity Domain models.
- User-delegated versus service-account Oracle access.
- Regions, residency, retention, backups, recovery, and customer-managed keys.
- Database, queue, cache, and secret-store services.
- Tenant pricing, quotas, and support model.
- Whether write, administration, job, or business-rule tools will ever be offered; they remain deferred.
