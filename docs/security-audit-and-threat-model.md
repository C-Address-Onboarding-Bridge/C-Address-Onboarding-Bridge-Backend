# Security Audit Report and Threat Model

## Purpose and Scope

This document records the current security posture for the C-Address Onboarding Bridge backend, including the Express API server, TypeScript SDK entry points, CEX/off-ramp routing modules, webhook handlers, and Soroban onboarding bridge interactions. It is intended for auditors, reviewers, and maintainers who need a shared view of expected controls and residual risk.

The system helps route funds from a funding source such as a G-address, CEX withdrawal, card ramp, or partner off-ramp into a Soroban smart account target. The most important security goals are preserving fund routing integrity, preventing unauthorized bridge operations, protecting user and integration secrets, and keeping enough audit evidence to investigate incidents.

## Assets

- User-controlled destination identifiers, including C-address targets and any linked G-address funding sources.
- API keys, webhook signing secrets, provider credentials, and environment configuration.
- XDR payloads, transaction hashes, quote data, bridge requests, and provider webhook events.
- Administrative actions that change routing, limits, provider configuration, or deployment settings.
- Logs and audit records used to reconstruct funding and onboarding flows.

## Trust Boundaries

- Wallet or dApp clients are untrusted until requests are authenticated and validated.
- The SDK is a client convenience layer and must not be treated as a trusted enforcement point.
- The API server is the main policy enforcement boundary for authentication, request validation, rate limiting, and audit logging.
- CEX, card ramp, and off-ramp providers are external systems; their callbacks require signature verification and replay protection.
- Soroban contract calls cross from backend-controlled orchestration into on-chain execution; XDRs and contract IDs must be validated before submission.
- CI/CD and hosting configuration are privileged operational boundaries because leaked secrets or unsafe deployments can bypass application controls.

## STRIDE Threat Model

### Spoofing

Risks:

- Forged API clients submitting bridge or quote requests.
- Attackers claiming ownership of a destination address or funding source they do not control.
- Fake provider webhook events that imitate CEX, fiat ramp, or off-ramp status changes.

Controls:

- Require API key or session authentication for privileged backend routes.
- Validate C-address and G-address formats before processing and bind requests to the authenticated actor where applicable.
- Verify webhook signatures, timestamps, provider identifiers, and event IDs before state changes.
- Reject callbacks that do not match an expected provider, quote, deposit, or bridge request record.

### Tampering

Risks:

- XDR payloads modified after quote creation.
- Provider webhook payloads edited in transit or replayed with different status fields.
- Configuration changes that route funds to an attacker-controlled contract or provider endpoint.

Controls:

- Treat XDRs as immutable once generated; store or derive a stable hash for comparison before submission.
- Use provider webhook HMAC/signature verification and replay windows.
- Validate Soroban contract IDs, network passphrases, asset codes, and destination addresses against configured allowlists.
- Restrict administrative configuration changes and record before/after values in audit logs.

### Repudiation

Risks:

- A user or operator denies creating a bridge request, changing provider configuration, or processing a webhook.
- Incident responders cannot reconstruct the sequence from quote to transaction submission.

Controls:

- Emit structured audit events for authentication, quote creation, route selection, webhook receipt, transaction submission, failures, and administrative changes.
- Include stable correlation IDs across API requests, provider callbacks, SDK calls, and on-chain transactions.
- Preserve enough metadata to prove what was received and what decision was made without logging raw secrets or excessive personal data.

### Information Disclosure

Risks:

- API keys, webhook secrets, provider tokens, or private environment values exposed in logs or responses.
- PII or payment-provider metadata leaked through debug logs, errors, analytics, or support exports.
- XDR or transaction details exposing user behavior beyond what is needed for support and audit.

Controls:

- Mask API keys, bearer tokens, webhook secrets, account identifiers, and provider reference IDs in logs.
- Return generic error messages to clients while keeping detailed diagnostics in restricted server logs.
- Keep .env.example complete but never commit real secrets.
- Limit who can read production logs and provider dashboards.

### Denial of Service

Risks:

- High-volume quote or bridge requests exhausting provider quotas or backend resources.
- Repeated webhook delivery causing expensive duplicate processing.
- External provider outages cascading into unavailable onboarding flows.

Controls:

- Apply per-client and per-route rate limits for quote, bridge, and webhook endpoints.
- Make webhook handling idempotent by event ID and internal bridge request ID.
- Use provider timeouts, circuit breakers, and retry budgets for external calls.
- Degrade gracefully when a provider is unavailable and expose actionable status to clients.

### Elevation of Privilege

Risks:

- Normal users accessing administrator-only provider or routing controls.
- SDK consumers bypassing backend policy checks by crafting direct privileged requests.
- Compromised CI/CD credentials changing deployment targets or secrets.

Controls:

- Enforce RBAC or explicit administrator checks on management endpoints.
- Keep all authorization checks server-side; the SDK must not be the source of truth.
- Use least-privilege deployment tokens and rotate secrets after suspected exposure.
- Separate production and testnet configuration and require review for production contract/provider changes.

## Security Assumptions

- Soroban network consensus and the deployed onboarding bridge contract behave according to their documented rules.
- External CEX, fiat ramp, and off-ramp providers protect their own account credentials and signing keys.
- Operators keep production secrets out of source control and restrict access to hosting dashboards.
- Clients can be malicious or compromised; backend validation is required for every security-sensitive action.

## Known Security Considerations

- The backend is a central coordination point for routing and provider integration. A compromised deployment, secret store, or administrator account could affect many users.
- External provider availability and correctness are outside the repository's direct control.
- Logs are necessary for dispute resolution and incident response, but they must be minimized and access-controlled.
- Any future custody-like behavior should receive a separate review before production use.

## Incident Response Plan

1. Triage the report or alert and assign a severity based on affected funds, authentication bypass, data exposure, or service availability.
2. Preserve evidence: relevant audit events, request IDs, provider event IDs, transaction hashes, deployment versions, and configuration changes.
3. Contain active risk by disabling affected providers, rotating secrets, pausing unsafe routes, or blocking abusive API keys.
4. Remediate the root cause in code, configuration, contract settings, or provider integration.
5. Validate the fix in testnet/staging, then deploy with reviewer approval.
6. Communicate impact, affected versions, mitigations, and upgrade or migration steps to users when applicable.
7. Complete a post-incident review and add follow-up issues for control gaps.

## Vulnerability and Bounty Guidance

Security reports should include affected component, impact, reproduction steps or proof of concept, and whether the issue has been disclosed elsewhere. Good-faith researchers should avoid accessing private data, moving funds, locking funds, or testing against third-party infrastructure without permission.

A bounty is not guaranteed unless maintainers attach one to an issue or announce an external program. When a bounty exists, the PR or report should reference the relevant issue and follow the program's claim instructions.

## Previous Audit Results

No prior third-party audit report is documented in this repository at the time this file was added. When audits are completed, maintainers should record the audit date, scope, auditor, high-level findings, remediation PRs, and any unresolved accepted risks in this section.

## Review Cadence

- Review this threat model at least quarterly.
- Review it before mainnet launch, production provider onboarding, contract upgrades, or major authentication and routing changes.
- Revisit it after any high-severity incident or externally reported vulnerability.
