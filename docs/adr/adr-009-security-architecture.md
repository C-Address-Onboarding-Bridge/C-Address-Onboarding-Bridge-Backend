# ADR-009: Security Architecture — Defense-in-Depth for the Onboarding Bridge API

- **Status**: Accepted
- **Date**: 2026-06-30
- **Deciders**: Engineering team

---

## Context

The Onboarding Bridge API handles financial operations: routing funds from exchanges and fiat on-ramps to Soroban smart accounts. This makes it an attractive target for authentication bypass, webhook forgery, and abuse. Prior to this ADR, security controls were implemented ad-hoc with no documented threat model or security architecture.

Key requirements driving this decision:

1. API keys must be usable without a full identity platform (no OAuth, no external IdP required for initial launch).
2. Webhook integrity must be verifiable without sharing secrets in both directions.
3. The system must degrade gracefully under attack rather than fail open.
4. Admin operations on the smart contract must not be executable by a single compromised key.
5. All sensitive values must be redacted from logs by default.

---

## Decision

Adopt a layered, defense-in-depth security architecture with the following components:

### Layer 1 — Transport Security
TLS is enforced at the ingress/load balancer. The API server binds to `HOST` and `PORT`; in production this should be `127.0.0.1:3001` behind a TLS-terminating reverse proxy.

### Layer 2 — API Key Authentication with RBAC
- Keys use the `cab_` prefix with 256 bits of random entropy.
- Keys are stored as SHA-256 hashes; raw keys are never persisted.
- Per-key scope grants (`quote:read`, `fund:write`, `status:read`, `offramp:write`, `cex:read`, `admin:keys`) limit blast radius if a key is compromised.
- Optional IP CIDR whitelist and expiry per key.
- Auth is skipped when `API_KEYS` is empty (dev mode only — startup validation should enforce non-empty in production).

### Layer 3 — Input Validation and Injection Protection
Pattern-based detection for SQL injection, NoSQL operators, and XSS in all request inputs (body, query, params). Request size limits by content type. Parameter pollution rejection.

### Layer 4 — Rate Limiting and Abuse Detection
Three-tier rate limiting (IP-global, per-key-tier, fund-endpoint-specific) backed by Redis for distributed consistency. Abuse detection for large amounts, rapid requests, and address scatter. Progressive IP banning.

### Layer 5 — Webhook Integrity
HMAC-SHA256 with provider-specific secrets. Timing-safe comparison. Replay protection via 5-minute nonce window. Timestamp validation. Rate limiting on failed verification attempts per IP.

### Layer 6 — Secret Redaction in Logs
Pino-based structured logging with a configurable redact list covering all known sensitive field names. Log rate limiting prevents log-based DoS.

### Layer 7 — Smart Contract Multi-Sig
Admin operations (fee changes, fee withdrawal, pause/unpause) require a multi-sig proposal cycle. Mainnet threshold is 2-of-N. Fee cap is immutable after initialization.

### Layer 8 — Circuit Breaker
All Soroban RPC calls are wrapped in a circuit breaker. Open state prevents cascade failures. Multiple RPC URLs provide redundancy.

---

## Consequences

**Positive**:
- A single compromised API key cannot execute admin contract operations.
- Log leakage does not expose raw keys or secrets.
- Webhook forgery requires breaking HMAC-SHA256 or stealing the webhook secret.
- Rate limiting and abuse detection reduce the impact of volumetric attacks.
- On-chain events provide a permanent, tamper-evident audit trail.

**Negative / Trade-offs**:
- The in-memory audit log and rate limit counters are lost on process restart (mitigated by Loki integration and Redis).
- Pattern-based injection detection is not a substitute for parameterized queries; if a database with dynamic queries is added, this must be revisited.
- Auth-disabled dev mode (`API_KEYS` empty) is a footgun for misconfigured production deployments.

---

## Alternatives Considered

### OAuth 2.0 / JWT
Rejected for initial launch: requires an external authorization server, adds operational complexity, and is unnecessary for the machine-to-machine API key use case.

### Single API key (no RBAC)
Rejected: a single compromised key would grant full access to all endpoints. Scoped keys limit blast radius.

### Contract with single admin
Rejected: single point of failure. Multi-sig is required for mainnet to prevent unilateral admin operations.

---

## Related ADRs

- [ADR-002: Stateless API server with no database](adr-002-stateless-api-server-with-no-database.md) — explains why audit log is in-memory
- [ADR-005: REST API with API key authentication](adr-005-rest-api-with-api-key-authentication.md) — original auth decision
- [ADR-001: Use Soroban for smart contract execution](adr-001-use-soroban-for-smart-contract-execution.md) — on-chain security properties

## Related Documents

- [docs/security/threat-model.md](../security/threat-model.md)
- [docs/security/incident-response.md](../security/incident-response.md)
- [SECURITY.md](../../SECURITY.md)
