# Authentication and authorization roadmap

Last reviewed: 2026-08-12

This roadmap covers authentication and authorization for a commercially deployed Oracle EPM NSPB MCP server. It does not reactivate job or business-rule execution.

## Two independent authorization relationships

1. **MCP client to MCP server:** OAuth decides which verified user and tenant may invoke each MCP tool.
2. **MCP server to Oracle EPM:** Basic credentials or Oracle-issued OAuth tokens authorize access to the selected tenant's Oracle environment.

An inbound MCP token must never be forwarded to Oracle. These tokens have different issuers, audiences, scopes, lifecycles, and purposes.

## Phase 1: inbound OAuth with Oracle IDCS or OCI IAM

- Deploy the HTTP MCP endpoint at a stable public HTTPS origin.
- Create an integrated resource application for the MCP server.
- Define an audience and least-privilege scopes such as `epm.read`; keep future write and administration scopes separate.
- Use Authorization Code with PKCE `S256`, exact redirect URIs, and only required grant types.
- Publish OAuth Protected Resource Metadata and reference the authorization server metadata.
- Return an RFC-compliant `401 Unauthorized` and `WWW-Authenticate` challenge for missing or invalid bearer tokens.
- Validate signature, exact issuer, audience, expiration, not-before time, and required scopes against the issuer's JWKS.
- Preserve the configured issuer exactly, including any significant trailing slash.
- Cache discovery and signing keys safely, support rotation, and fail closed.
- Use compatible MCP SDK resource-server helpers and evaluate the SDK upgrade path before production authentication becomes a release gate.
- Add `jose` as a direct production dependency if used for JWT validation.
- Keep metadata and health endpoints intentionally public; protect `/mcp` and all data-bearing endpoints.
- **Implemented:** configure approved browser origins with `MCP_ALLOWED_ORIGINS`; incoming-request authentication remains separate from the browser-origin allowlist.
- Log safe authentication outcomes and subject identifiers, never tokens, secrets, or passwords.
- Test each target MCP host with pre-registered or dynamic client registration; do not assume compatibility.
- Keep local `stdio` transport environment-authenticated and free of browser OAuth behavior.

Expected configuration:

| Setting | Purpose |
| --- | --- |
| `MCP_PUBLIC_URL` | Canonical HTTPS URL and protected-resource identifier. |
| `IDCS_DOMAIN_URL` | Identity Domain discovery and JWKS base URL. |
| `IDCS_ISSUER` | Exact accepted JWT issuer. |
| `IDCS_AUDIENCE` | Required MCP resource audience. |
| `IDCS_REQUIRED_SCOPES` | Minimum scopes required for the read-only tools. |

Release tests must cover absent and malformed tokens, invalid signatures, wrong issuer or audience, expired and not-yet-valid tokens, insufficient scopes, key rotation, unavailable discovery/JWKS services, and successful requests.

## Phase 2: outbound Oracle EPM OAuth

- Register the appropriate integrated OAuth client in the tenant's Oracle Identity Domain.
- Configure EPM as a resource with the required secondary audience and token-issuance policy.
- Apply Oracle's July 2026 EPM OAuth configuration requirements before enabling production tenants.
- Request the documented service-instance scope and verify scope and audience during onboarding.
- Obtain consent and the initial refresh token through a deliberate onboarding flow when user context is required.
- Store client secrets and refresh tokens encrypted in OCI Vault or an equivalent managed secret store—not source, committed `.env` files, logs, browser storage, or the general tenant database.
- Cache access tokens only for the correct tenant/user/resource tuple and use distributed locking around refresh.
- Handle revoked consent, invalid grants, and rotated secrets with an actionable reauthorization state and redacted errors.
- Retain Basic Authentication only as an explicit migration/deployment option, with credentials in managed secret storage.

## Authorization policy decisions

- Choose user-delegated Oracle access, tenant service accounts, or a documented combination per tool category.
- Map MCP scopes and application roles explicitly; never infer Oracle permissions from an unverified claim.
- Establish whether the product uses one vendor-managed Identity Domain with federation, customer-owned domains, or both.
- Keep job, rule, write, and administration permissions unavailable until separately designed and approved.

## References

- [MCP Authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- [MCP TypeScript SDK authorization guidance](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/authorization.md)
- [Oracle EPM OAuth 2.0 authentication](https://docs.oracle.com/en/cloud/saas/enterprise-performance-management-common/prest/authentication_oath.html)
- [Oracle EPM July 2026 OAuth configuration update](https://docs.oracle.com/en/cloud/saas/readiness/epm/2026/epm-jul26/26jul-epm-wn-f50410.htm)
- [OCI JWT validation with Identity Domains](https://docs.oracle.com/en-us/iaas/Content/APIGateway/Tasks/apigatewayusingjwttokens-identityprovider.htm)

See also [multi-tenancy-roadmap.md](multi-tenancy-roadmap.md) for tenant-specific issuer resolution and isolation.
