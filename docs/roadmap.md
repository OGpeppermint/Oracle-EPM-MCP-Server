# Oracle EPM NSPB MCP roadmaps

Last reviewed: 2026-10-17

The project roadmap is separated by concern so endpoint scope, identity, and tenant architecture can evolve independently.

| Roadmap | Scope |
| --- | --- |
| [Endpoint roadmap](endpoint-roadmap.md) | Active Oracle EPM tools, deferred endpoints, removed job and rule execution, and APIs outside the current NSPB scope. |
| [Authentication and authorization roadmap](authentication-roadmap.md) | Inbound MCP OAuth with Oracle IDCS/OCI IAM, outbound Oracle EPM OAuth, token boundaries, secrets, and authentication test requirements. |
| [Multi-tenancy roadmap](multi-tenancy-roadmap.md) | Tenant context, registry, routing, isolation, onboarding, operational controls, release gates, and commercial deployment progression. |

The roadmaps share these constraints:

- The current product remains read-only in intent; job and business-rule execution remain disabled.
- An inbound MCP access token must never be passed through to Oracle EPM.
- Tenant identity must be established from trusted routing and verified authorization context, never from a tool argument.
- Higher-risk write and administrative operations require separate design, authorization, confirmation, and testing before activation.

## Overall roadmap

Status labels:

- **Complete:** implemented and covered by the current project verification.
- **Next:** the recommended next body of work.
- **Planned:** sequenced after its prerequisites.
- **Deferred:** intentionally unavailable pending product and security design.

### Milestone 1: read-only NSPB MCP foundation — Complete

- HTTP Streamable MCP and local `stdio` transports.
- Standard MCP interface for hosts and external clients, including the independently maintained Command Center.
- Fourteen active tools covering API discovery, applications, summaries, plan types, dimensions, members, job inspection, substitution variables, data-slice export, and local connection status.
- Descriptive tool schemas and a complete [tool reference](tool-reference.md).
- Explicit JSON request headers and endpoint-specific Application Summary compatibility handling.
- Removal of unsupported recent-job collection retrieval after Oracle returned HTTP 405.
- Removal of job and business-rule execution from the server.
- Build, MCP contract, absence of GUI resources, and release-compliance verification.
- Proprietary release placeholder, third-party notices, license texts, and automated notice checks.

Exit state: the project operates as a single-environment, read-only MCP server with an optional GUI maintained in a separate repository. See the [endpoint roadmap](endpoint-roadmap.md).

### Milestone 2: production configuration and operational hardening — Next

- Adopt a documented production configuration strategy instead of relying on implicit `.env` loading.
- Validate all required settings at startup with safe, actionable errors.
- Add structured logs, correlation IDs, redaction, request timeouts, bounded retries, and response-size controls.
- Restrict production CORS and document reverse-proxy, HTTPS, health-check, and shutdown behavior.
- Add automated HTTP transport tests for content negotiation, session behavior, and MCP error responses.
- Establish supported Node.js and MCP SDK versions and an upgrade policy.
- Add dependency, secret, and vulnerability scanning to the release workflow.

Release gate: repeatable deployment, no secrets in artifacts or logs, graceful failure behavior, and passing transport/security checks.

### Milestone 3: single-tenant Oracle IDCS authorization — Planned

- Register the MCP server as an Oracle IDCS/OCI IAM protected resource.
- Add OAuth Protected Resource Metadata, bearer challenges, and JWT verification.
- Enforce exact issuer, audience, signature, time, and scope validation.
- Use Authorization Code with PKCE for compatible interactive clients.
- Keep `stdio` local and environment-authenticated rather than attempting browser OAuth.
- Verify compatibility with every intended MCP host and its client-registration model.

Release gate: complete positive and negative token-validation tests, signing-key rotation tests, restricted CORS, and no token or secret leakage. See the [authentication and authorization roadmap](authentication-roadmap.md).

### Milestone 4: Oracle EPM OAuth and managed secrets — Planned

- Register tenant-specific Oracle OAuth clients and configure the required EPM resource, scope, secondary audience, and token policy.
- Comply with Oracle's July 2026 EPM OAuth configuration update.
- Store Basic credentials, client secrets, and refresh tokens in OCI Vault or an equivalent managed secret store.
- Add encrypted refresh-token handling, tenant/user/resource-scoped access-token caching, distributed refresh locking, and reauthorization states.
- Decide which tool categories use delegated users versus tenant service accounts.

Release gate: secrets are absent from source, `.env` release artifacts, logs, browser state, and the general application database; revocation and rotation are tested.

### Milestone 5: tenant-ready server architecture — Planned

- Replace global Oracle configuration with dependency-injected tenant, user, scope, and Oracle connection context.
- Validate all application selections against tenant policy.
- Create the tenant registry, identity bindings, Oracle connection records, and audit event model.
- Separate tenant administration into a protected control plane.
- Add hostname-first tenant resolution and strict Oracle-origin/SSRF protections.

Release gate: forged tool arguments, claims, URLs, and hostnames cannot change tenant routing or Oracle destinations. See the [multi-tenancy roadmap](multi-tenancy-roadmap.md).

### Milestone 6: first commercial tenant deployment — Planned

- Begin with a dedicated customer deployment or a shared control plane with a dedicated tenant data plane.
- Implement tenant onboarding, application approval, quotas, audit policy, retention, suspension, reauthorization, and offboarding.
- Add customer-facing operational documentation, support boundaries, backup/recovery procedures, and service monitoring.
- Complete license/legal review, security review, privacy terms, Oracle branding/API-usage review, and commercial agreements appropriate to the chosen deployment.
- Produce a versioned release package with notices, checksums, deployment instructions, configuration reference, changelog, support policy, and known limitations.

Release gate: successful customer acceptance testing, recoverability exercise, credential rotation, security assessment, and documented support ownership.

### Milestone 7: shared multi-tenant SaaS — Planned after dedicated deployment

- Add tenant-keyed caches, queues, limits, retries, token state, logs, metrics, traces, exports, and UI persistence.
- Enforce per-tenant quotas, backpressure, data lifecycle, support access, and operational visibility.
- Test with at least two deliberately similar tenants and negative cases for every cross-tenant identifier.
- Complete deployment-level penetration testing and an independent architecture/security review.
- Add regional deployment and data-residency controls if required by the commercial offering.

Release gate: automated isolation tests prove that no tool, UI action, cache, retry, error, log, metric, export, or support path can cross tenant boundaries.

### Milestone 8: controlled feature expansion — Deferred

Consider additional endpoints only after the preceding authorization and tenant controls exist. Prioritize frequently used read-only APIs before writes. Any mutation should have a purpose-specific tool schema, least-privilege scope, validation, explicit confirmation where appropriate, idempotency/ambiguous-timeout behavior, audit events, and tenant isolation tests.

Job submission and business-rule execution remain disabled. Their future inclusion requires a separate approved design and does not follow automatically from completing OAuth or multi-tenancy.

## Cross-roadmap dependency order

```text
Read-only MCP foundation
  -> production hardening
  -> inbound MCP OAuth
  -> managed Oracle authentication
  -> tenant-context refactor and registry
  -> dedicated commercial deployment
  -> pooled multi-tenant SaaS
  -> controlled write/administrative expansion
```

## Project-level decisions

- Commercial deployment model: dedicated, hybrid, or pooled.
- Identity model: vendor-managed federation, customer-owned Identity Domains, or both.
- Oracle authorization model: delegated users, service accounts, or a tool-specific combination.
- Hosting region, residency, retention, recovery, encryption-key, and support commitments.
- Control-plane database, cache, queue, secrets, and observability services.
- Product packaging, pricing, quotas, support tiers, and service-level objectives.
- Whether job, rule, write, and administrative functionality is part of the long-term product scope.
