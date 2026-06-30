# Security Policy

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

If you discover a security vulnerability in the C-Address Onboarding Bridge, please report it
privately so we can investigate and release a fix before public disclosure.

### How to Report

Send a report to **security@c-address-bridge.example** with:

1. A clear description of the vulnerability
2. Steps to reproduce (or a proof-of-concept)
3. The potential impact (what an attacker could achieve)
4. Your suggested severity (Critical / High / Medium / Low)
5. Your contact details (optional, for follow-up)

You may encrypt your report using our PGP key (published on keybase.io at
`keybase.io/c-address-bridge`).

### Alternatively: GitHub Private Vulnerability Reporting

You can also use GitHub's built-in private reporting:
[Report a vulnerability](../../security/advisories/new)

---

## Response SLA

We aim to respond to all security reports according to the following timelines:

| Severity | Initial response | Fix target | Public disclosure |
|----------|-----------------|------------|-------------------|
| Critical | 24 hours | 7 days | After patch + 7 days |
| High | 48 hours | 30 days | After patch + 14 days |
| Medium | 5 business days | 90 days | After patch + 30 days |
| Low | 10 business days | Next release | After patch |

We will keep you informed of progress throughout the process.

---

## Scope

### In Scope

The following are considered in scope for security reports:

- **API server** (`api/`) — authentication bypass, injection vulnerabilities, privilege escalation, information disclosure, denial of service
- **Soroban smart contract** (`contracts/onboarding-bridge/`) — fund manipulation, fee bypass, unauthorized admin operations, reentrancy
- **Webhook verification** — signature bypass, replay attack, timing oracle
- **SDK** (`sdk/`) — vulnerabilities that could affect applications built on the SDK
- **CI/CD pipeline** (`.github/workflows/`) — secrets exposure, workflow injection, unauthorized deployment
- **Dependencies** — critical/high severity CVEs in direct npm or Cargo dependencies that are exploitable through the project's attack surface

### Out of Scope

The following are **not** in scope:

- Vulnerabilities in the Stellar / Soroban network itself
- Moonpay or Transak platform vulnerabilities (report directly to those providers)
- Theoretical attacks with no realistic exploit path
- Attacks requiring physical access to infrastructure
- Rate-limiting issues that require more than 100,000 requests to demonstrate impact
- Social engineering of team members
- Issues already publicly known or previously reported

---

## Bug Bounty Program

We do not currently operate a paid bug bounty program. Outstanding security contributions may
be recognized in release notes and the project's security hall of fame (below) at the reporter's
discretion.

We are evaluating a formal bug bounty program ahead of the mainnet launch. Reporters who submit
valid P1/P2 findings before the program launch will be considered retroactively if the program
is established.

---

## Security Hall of Fame

We thank the following researchers for responsible disclosure:

_No reports have been received yet. Your name could be here._

---

## Past Security Audit Findings

### Audit History

| Date | Auditor | Scope | Report |
|------|---------|-------|--------|
| — | — | Pre-launch audit pending | — |

No external security audits have been completed yet. A pre-launch audit of the Soroban smart
contract and API security posture is planned before mainnet deployment.

### Known Issues / Accepted Risks

| ID | Component | Description | Status |
|----|-----------|-------------|--------|
| SEC-001 | `offramp/moonpay.ts` | `verifyMoonpayWebhook` lacks a length guard before `timingSafeEqual`; use the middleware version (`webhookVerification.ts`) instead | Tracked, low-risk (middleware path is the intended call site) |
| SEC-002 | `middleware/auth.ts` | Authentication is disabled when `API_KEYS` is empty — by design for development, but must not reach production | Tracked, startup validation recommended |
| SEC-003 | `middleware/rbacAuth.ts` | Audit log is in-memory only; lost on process restart | Tracked, requires Loki/database integration |

---

## Security Architecture

For a full description of the system's security controls, trust boundaries, and threat model, see:

- [docs/security/threat-model.md](docs/security/threat-model.md) — STRIDE threat model
- [docs/security/incident-response.md](docs/security/incident-response.md) — incident response playbooks
- [docs/adr/adr-009-security-architecture.md](docs/adr/adr-009-security-architecture.md) — security architecture decisions

### Summary of Controls

| Layer | Control |
|-------|---------|
| Transport | TLS (enforced at ingress) |
| Authentication | `X-API-Key` (RBAC, scopes, IP whitelist, expiry, revocation) |
| Authorization | Scope-based (`quote:read`, `fund:write`, `status:read`, `offramp:write`, `cex:read`, `admin:keys`) |
| Input validation | SQL/NoSQL/XSS pattern detection, size limits, parameter pollution protection |
| Rate limiting | IP (100/min), per-key tier (30–500/min), fund endpoint (10/min), abuse detection, IP banning |
| Webhook integrity | HMAC-SHA256, timing-safe compare, replay protection (5-min nonce window), timestamp validation |
| Secret protection | Pino redaction of 10+ sensitive field paths; keys stored as SHA-256 hashes |
| Availability | Circuit breaker (Soroban RPC), graceful Redis fallback, log rate limiting |
| Contract access control | Multi-sig proposals (configurable threshold), fee cap immutable after init |
| Audit trail | In-memory RBAC audit log + on-chain contract events (permanent) |
| Supply chain | Weekly automated dependency audit (npm + Cargo), WASM SHA-256 in deployment artifact |

---

## Security Review Cadence

| Review | Frequency |
|--------|-----------|
| Automated dependency scan | Weekly (GitHub Actions) |
| Threat model review | Quarterly |
| External security audit | Pre-mainnet launch, then annually |
| Secret rotation | On suspected compromise, or annually |
| Contract audit | Before each major contract upgrade |

---

## Preferred Languages

We accept security reports in English or Spanish.
