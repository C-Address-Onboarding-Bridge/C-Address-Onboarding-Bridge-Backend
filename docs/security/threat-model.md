# Threat Model — C-Address Onboarding Bridge

**Methodology**: STRIDE  
**Last reviewed**: 2026-06-30  
**Status**: Active

---

## 1. System Overview

The Onboarding Bridge routes funds from G-addresses and CEX withdrawals directly into Soroban smart accounts (C-addresses) on Stellar. It consists of four components with distinct trust characteristics:

```
┌──────────────────────────────────────────────────────────────────┐
│  External callers                                                │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────────┐  │
│  │  dApp /  │  │   CEX    │  │ Moonpay  │  │    Transak     │  │
│  │   SDK    │  │ withdraw │  │ webhook  │  │    webhook     │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └───────┬────────┘  │
└───────┼─────────────┼─────────────┼─────────────────┼───────────┘
        │             │             │                 │
        ▼             ▼             ▼                 ▼
┌──────────────────────────────────────────────────────────────────┐
│  Trust Boundary A: API Layer (Express, TLS-terminated)           │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Middleware stack:                                        │   │
│  │  IP rate limit → API key auth → RBAC scopes → injection  │   │
│  │  protection → request size → idempotency → versioning    │   │
│  └──────────────────────────────────────────────────────────┘   │
└──────────────────────────────┬───────────────────────────────────┘
                               │
        ┌──────────────────────┼──────────────────────┐
        ▼                      ▼                       ▼
┌───────────────┐   ┌──────────────────────┐   ┌────────────────┐
│  Trust        │   │  Trust Boundary B:   │   │  Trust         │
│  Boundary C:  │   │  Soroban RPC (HTTPS) │   │  Boundary D:   │
│  Redis        │   │  Circuit breaker     │   │  PostgreSQL    │
│  (rate limit/ │   │  wraps all calls     │   │  (optional)    │
│  cache)       │   └──────────┬───────────┘   └────────────────┘
└───────────────┘              │
                               ▼
              ┌───────────────────────────────────┐
              │  Trust Boundary E: Soroban Network │
              │  OnboardingBridge contract          │
              │  (immutable, on-chain logic)        │
              └───────────────────────────────────┘
```

### Assets to Protect

| Asset | Sensitivity | Location |
|-------|-------------|----------|
| API keys (`cab_...` prefix, 32 random bytes) | High | env var / key store (hashed SHA-256) |
| Soroban deployer secret key (`S...`) | Critical | GitHub Actions secrets only |
| Moonpay / Transak webhook secrets | High | env vars |
| Admin addresses controlling the contract | High | on-chain / GitHub secrets |
| User wallet addresses | Medium | logs (redacted), request payloads |
| User email addresses | Medium | Moonpay widget URL only |
| Transaction hashes and amounts | Low | logs, on-chain (public) |

---

## 2. Trust Boundaries

### Boundary A — Public Internet → API Server
Callers are untrusted. All inbound HTTP traffic must pass the middleware stack before reaching business logic. TLS termination is assumed at the load balancer or ingress controller; the API server itself should not accept unencrypted connections in production.

**Assumption**: The host/container network prevents direct access to internal ports. The `HOST=0.0.0.0` default should be tightened to `127.0.0.1` when a reverse proxy handles TLS.

### Boundary B — API Server → Soroban RPC
The RPC endpoint is an external Stellar network node. Responses are treated as untrusted; the circuit breaker (`CircuitBreaker` in `circuit-breaker.ts`) limits blast radius of an unresponsive or malicious node. Multiple RPC URLs can be configured for redundancy.

**Assumption**: RPC communication uses HTTPS. An on-path attacker who can forge RPC responses could mislead the API about transaction status, but cannot alter on-chain state.

### Boundary C — API Server → Redis
Redis stores rate limit counters and cache data. It holds no user secrets. Access should be restricted to the application subnet; unauthorized Redis writes could reset rate limits or poison the quote cache.

**Assumption**: Redis is deployed on an isolated internal network with no public exposure. At-rest encryption is not required for rate limit data but is recommended for cached transaction data.

### Boundary D — API Server → PostgreSQL
The database is optional. If enabled, it stores audit records. The connection string is a critical secret.

### Boundary E — API Server → Soroban Contract
The smart contract is immutable after deployment. The API server acts as a caller, not an admin (admin operations require multi-sig proposals). Contract state is public; sensitive business logic is enforced on-chain by the contract itself.

**Assumption**: The contract's `initialize()` function is guarded by the `Version` idempotency check — it can only be called once per deployment. Admin keys are held in hardware or Secrets Manager, not on the API server.

---

## 3. STRIDE Threat Analysis

### 3.1 Spoofing

#### S-1: API Key Spoofing
**Threat**: An attacker presents a forged or stolen `X-API-Key` to authenticate as a legitimate client.  
**Component**: `middleware/auth.ts`, `middleware/rbacAuth.ts`  
**Mitigation**:
- Keys are stored as SHA-256 hashes in the key store; the raw key is never persisted.
- Keys have the `cab_` prefix and are 64 hex chars (256 bits of entropy).
- RBAC middleware checks revocation status and expiry on every request.
- IP whitelist (CIDR) can restrict keys to known source ranges.
- `API_KEYS` empty → auth disabled (dev mode only — must not reach production).

**Residual risk**: A compromised key grants access until explicitly revoked. Rotation and short expiry (`expiresAt`) are the primary mitigations.

**Recommendation**: Enforce `API_KEYS` to be non-empty via startup validation in production. Add a `REQUIRE_AUTH` flag that fails hard if unset.

---

#### S-2: Webhook Impersonation
**Threat**: An attacker sends a forged Moonpay or Transak webhook to trigger unauthorized state changes (e.g., fraudulent payment confirmation).  
**Component**: `middleware/webhookVerification.ts`  
**Mitigation**:
- HMAC-SHA256 with per-provider secrets (`MOONPAY_SECRET_KEY`, `TRANSAK_WEBHOOK_SECRET`).
- Timing-safe comparison (`crypto.timingSafeEqual`) prevents timing oracle attacks.
- Replay protection: nonce window of 5 minutes keyed on the signature value.
- Timestamp validation: payload `timestamp` / `createdAt` must be within ±5 min.
- Brute-force mitigation: 10 failed verification attempts per IP per minute before rate limiting.

**Residual risk**: If the webhook secret is leaked, an attacker can forge valid webhooks. Secret rotation must be coordinated with the provider.

---

#### S-3: Stellar Address Spoofing (C vs. G-address confusion)
**Threat**: A caller submits a G-address as the `targetAddress` in a fund request, causing funds to land in a classical Stellar account that the user does not control, or triggering an error that leaks information.  
**Component**: `sdk/src/utils.ts` (`isCAddress`), Soroban contract (`validate_c_address`)  
**Mitigation**:
- SDK validates addresses client-side before any API call.
- The Soroban contract's `validate_c_address` rejects any address not starting with `C` (contract addresses).
- The contract check is authoritative; the SDK check is defense-in-depth.

---

### 3.2 Tampering

#### T-1: Request Body Tampering / Injection Attacks
**Threat**: An attacker injects SQL, NoSQL operators (`$where`, `$ne`), or XSS payloads into request parameters to manipulate backend behavior.  
**Component**: `middleware/security.ts`  
**Mitigation**:
- `injectionProtection` middleware scans `req.body`, `req.query`, and `req.params` against SQL, NoSQL, and XSS pattern lists.
- `parameterPollutionProtection` rejects duplicate query parameters.
- `requestSizeLimiting` enforces per-content-type size limits (JSON: 32 KB, form: 16 KB).
- `contentTypeEnforcement` rejects non-JSON bodies on mutation endpoints (415).

**Residual risk**: Pattern-based detection is not a substitute for parameterized queries. If a database is added, all queries must use parameterized statements regardless of this middleware.

---

#### T-2: WASM / Contract Binary Tampering
**Threat**: A supply-chain attacker substitutes a malicious WASM binary during the CI/CD build pipeline.  
**Component**: `scripts/deploy-contract.sh`, `scripts/generate-deployment-report.sh`  
**Mitigation**:
- SHA-256 of the WASM binary is computed and stored in the deployment artifact (`deployments/deployment-<network>.json`).
- The deployment workflow uses `actions/checkout@v4` with pinned SHA.
- Mainnet deployments require human approval via GitHub Environments (required reviewers).
- The artifact `wasmHash` can be compared against a locally-built binary at any time:
  ```bash
  sha256sum target/wasm32v1-none/release/onboarding_bridge.wasm
  # compare with deployments/deployment-mainnet.json .wasmHash
  ```

**Residual risk**: Cargo dependencies are not reproducibly built by default. A compromised upstream crate could produce a different binary from the same source. Use `cargo auditable` and Sigstore/cosign for supply-chain provenance in high-assurance deployments.

---

#### T-3: Fee Manipulation
**Threat**: An API caller submits a crafted request attempting to bypass or reduce the contract fee.  
**Component**: `contracts/onboarding-bridge/src/lib.rs`  
**Mitigation**:
- Fee calculation is entirely on-chain in `fund_c_address_internal`; the API server has no influence over the fee amount.
- `fee_bps` is read from contract storage; changes require a multi-sig proposal (`propose` → `approve` × threshold → `execute`).
- `max_fee_bps` is immutable after initialization.

---

#### T-4: Replay of Idempotent Requests
**Threat**: An attacker replays a valid signed fund request to double-spend.  
**Component**: `middleware/idempotency.ts`  
**Mitigation**:
- The `X-Idempotency-Key` header enables idempotent POST handling; duplicate keys return the cached response.
- On-chain: the Soroban network rejects replayed transactions by sequence number.

---

### 3.3 Repudiation

#### R-1: Disputed Transaction Origin
**Threat**: A user or integration disputes having initiated a funding transaction.  
**Component**: `middleware/rbacAuth.ts` (audit log), Soroban contract events  
**Mitigation**:
- `rbacAuth` appends every authenticated request to an in-memory audit log: `{ ts, keyId, ip, path, method }`.
- The Soroban contract emits a `funded` event on-chain for every successful `fund_c_address` call, including source, target, amount, fee, and ledger sequence — this is the authoritative audit trail.
- Structured logs (pino) capture correlation IDs (`X-Correlation-ID`) tied to every request.

**Residual risk**: The in-memory audit log is lost on process restart. For production, route logs to an append-only store (Loki, CloudWatch Logs, or equivalent) and ensure the Loki push URL is configured. The on-chain event log is permanent and censorship-resistant.

---

#### R-2: Admin Action Non-Repudiation
**Threat**: A compromised admin key performs unauthorized operations (fee changes, fee withdrawal) and the actor denies it.  
**Component**: Soroban contract (`propose`, `approve`, `execute`)  
**Mitigation**:
- All admin actions require a multi-sig proposal with configurable threshold (default: 2 of N on mainnet).
- Each proposal records the proposer address and each approver address on-chain.
- On-chain events (`proposed`, `approved`, `executed`) provide a permanent, tamper-evident record.

---

### 3.4 Information Disclosure

#### I-1: API Key Leakage in Logs
**Threat**: API keys appear in log output, accessible to anyone with log access.  
**Component**: `api/src/logger.ts`  
**Mitigation**:
- Pino `redact` configuration censors the following paths with `[REDACTED]`:
  `authorization`, `x-api-key`, `apiKey`, `password`, `token`, `privateKey`, `mnemonic`, `secret`, `secretKey`, `signedXdr`
- Additional fields configurable via `LOG_SENSITIVE_FIELDS` env var.
- Keys are stored as SHA-256 hashes in the key store; the raw key is returned only at creation time.

**Residual risk**: Application code that logs request bodies before the redaction layer could leak partial key material. All logging must go through the `logger` instance, not `console.log`.

---

#### I-2: Secret Key Exposure (Deployer / Admin)
**Threat**: The Soroban deployer secret key (`S...`) or contract admin key leaks, enabling unauthorized contract operations.  
**Component**: GitHub Actions secrets, deployment pipeline  
**Mitigation**:
- Deployer keys are stored exclusively as GitHub Actions secrets; they are never written to disk or logs.
- The `scripts/deploy-contract.sh` pipeline reads `SOURCE_ACCOUNT` from the environment and never prints it.
- `GITHUB_OUTPUT` and step summaries log only `contract_id` and `wasm_hash`, not the source account.
- Mainnet keys (`SOROBAN_SOURCE_ACCOUNT_MAINNET`) are separate from testnet keys and restricted to the `mainnet` environment.

**Residual risk**: A GitHub Actions environment compromise (e.g., a malicious workflow injection) could exfiltrate the secret. Use short-lived OIDC credentials when the Stellar CLI gains OIDC support.

---

#### I-3: User Wallet Address / Email Leakage
**Threat**: Wallet addresses or emails passed through Moonpay/Transak widget URL construction appear in access logs or error responses.  
**Component**: `config.ts` (`logging.sensitiveFields`), route handlers  
**Mitigation**:
- `walletAddress` and `email` are in the `LOG_SENSITIVE_FIELDS` default list.
- Moonpay widget URLs are generated server-side; the URL is returned to the client and never logged at `info` level.
- Error responses sanitize via `sanitizeErrorMessage` (strips HTML/JS patterns).

---

#### I-4: Enumeration of Contract State
**Threat**: An attacker queries the contract to enumerate all funder addresses and amounts.  
**Component**: Soroban contract (public `funding_record`, `funding_count`)  
**Mitigation (by design)**: Stellar is a public blockchain. All contract storage is public. This is a known, accepted characteristic of on-chain protocols.

**Accepted risk**: Transparency is a feature. Sensitive business metrics should be derived off-chain and not stored in contract state.

---

### 3.5 Denial of Service

#### D-1: API Request Flooding
**Threat**: An attacker floods the API with requests to exhaust resources or trigger cascading failures.  
**Component**: `middleware/rateLimit.ts`  
**Mitigation**:
- Global IP rate limit: 100 req/min per IP before body parsing.
- Per-API-key tier limits: low=30, standard=100, high=500 req/min.
- Fund endpoint: 10 req/min (tightest limit — most resource-intensive path).
- Redis-backed store ensures limits survive process restarts and work across multiple instances.
- IP ban: after 3 ban-threshold violations (pattern detected ≥5 times), IP is banned for 1 hour.
- Abuse detection: large amounts, rapid requests, multiple target addresses trigger alerts and eventual bans.

---

#### D-2: Soroban RPC Unavailability
**Threat**: The Soroban RPC endpoint becomes unavailable, causing all API calls to hang or return 5xx.  
**Component**: `api/src/circuit-breaker.ts`  
**Mitigation**:
- Circuit breaker wraps all RPC calls: opens after `failureThreshold` (default 5) consecutive failures.
- Open state returns `503 CircuitOpenError` immediately without waiting for timeout.
- Half-open state tests recovery with up to 3 probe requests before re-closing.
- Multiple RPC URLs (`SOROBAN_RPC_URLS`, comma-separated) with round-robin / latency / random selection strategy.

---

#### D-3: Redis Unavailability
**Threat**: Redis goes down, disabling rate limiting and caching.  
**Component**: `middleware/redisRateLimitStore.ts`, `config.ts`  
**Mitigation**:
- When `REDIS_URL` is not set or Redis is unreachable, the system falls back to in-process memory store (per-instance, not shared).
- Rate limiting degrades gracefully rather than failing open or closed.

**Residual risk**: In-process fallback is per-instance; a multi-instance deployment without Redis has independent per-instance limits, potentially allowing 100 req/min × N instances from the same IP. Redis should be treated as a required dependency in production.

---

#### D-4: Log Flood (DoS via Logging)
**Threat**: An attacker generates a high volume of requests to flood log storage or cause out-of-memory crashes via unbounded log buffers.  
**Component**: `api/src/logger.ts`  
**Mitigation**:
- Log rate limiter: `LOG_RATE_LIMIT_PER_SEC` (default 100) drops excess log lines and emits a single `warn` with the dropped count.
- Aggregation stream batches log lines before forwarding to Loki/Logtail.

---

#### D-5: Smart Contract Storage Exhaustion
**Threat**: An attacker submits thousands of small fund transactions to exhaust persistent contract storage (Soroban ledger entries).  
**Component**: Soroban contract  
**Mitigation**:
- Each `FundingRecord` is in persistent storage with TTL extension; entries can be archived via `archive_old_entries` (admin).
- `min_amount` prevents dust transactions (configurable, default 100 stroops).
- Soroban ledger entry rent ensures old entries expire unless renewed; `archive_old_entries` can compact them.

---

### 3.6 Elevation of Privilege

#### E-1: Scope Escalation via Forged API Key
**Threat**: A low-privilege API key caller attempts to invoke admin-only endpoints or gain `fund:write` scope without authorization.  
**Component**: `middleware/rbacAuth.ts`, `requireScopes`  
**Mitigation**:
- Every protected route uses `requireScopes(...required)` middleware.
- Scopes are bound to the API key record and cannot be changed by the caller.
- Available scopes: `quote:read`, `fund:write`, `status:read`, `offramp:write`, `cex:read`, `admin:keys`.
- Scope checks run after RBAC auth; missing scopes return 403 with the required/missing scope list.

---

#### E-2: Contract Admin Privilege Escalation
**Threat**: A compromised single admin key is used to unilaterally drain contract fees, change fee rates, or pause the contract.  
**Component**: Soroban contract (`propose`, `approve`, `execute`)  
**Mitigation**:
- All admin operations require a multi-sig proposal reaching the configured threshold (default: 1 for testnet, 2 for mainnet).
- Proposals expire (`expiry_blocks`; min 10 blocks, max 100,000 blocks).
- Admin addresses cannot be the contract address itself (validated in `validate_admins`).
- Fee cap (`max_fee_bps`) is immutable after initialization, preventing fee manipulation beyond the agreed cap.

---

#### E-3: RBAC Disabled in Production
**Threat**: `RBAC_ENABLED=false` is accidentally set in production, bypassing all scope checks.  
**Component**: `config.ts`, `middleware/rbacAuth.ts`  
**Mitigation**:
- `RBAC_ENABLED` defaults to `true`; it must be explicitly set to `false` to disable.
- Even with RBAC disabled, `apiKeyAuth` (the simple key check) remains active when `API_KEYS` is non-empty.

**Recommendation**: Add a startup assertion that `RBAC_ENABLED=true` in `NODE_ENV=production`.

---

## 4. Security Assumptions

The threat model relies on the following assumptions being true. If any assumption is violated, the corresponding threats become significantly higher risk.

| # | Assumption | If Violated |
|---|------------|-------------|
| A1 | TLS termination is enforced at the ingress/load balancer; the API server is not reachable over plain HTTP from outside the VPC | API keys and webhook secrets transit in plaintext |
| A2 | `API_KEYS` is non-empty in all production deployments | Authentication is disabled; any caller can access all endpoints |
| A3 | GitHub Actions secrets (`SOROBAN_SOURCE_ACCOUNT_MAINNET`, etc.) are accessible only to authorized workflows | Mainnet deployer key is exposed; unauthorized contract operations become possible |
| A4 | Redis is deployed on an internal network, unreachable from the public internet | Rate limit counters can be reset or poisoned externally |
| A5 | The `mainnet` GitHub Environment has required reviewers configured | Mainnet contract deployments proceed without human approval |
| A6 | Webhook secrets (`MOONPAY_SECRET_KEY`, `TRANSAK_WEBHOOK_SECRET`) are rotated after any suspected compromise | Forged webhooks are accepted as legitimate |
| A7 | Container images are built from the pinned `Dockerfile`; base images are kept current | Vulnerable OS packages may be present in the runtime |
| A8 | On-chain contract admin threshold on mainnet is ≥ 2 | A single compromised key can execute admin operations |

---

## 5. Known Security Considerations

### 5.1 Centralization Risks
The bridge operates with a centralized API server. This creates a single point of failure and a potential censorship vector — the operator can block specific addresses or amounts at the API layer even if the on-chain contract would permit the operation. Mitigations for this risk (e.g., a permissionless contract invocation path) are architectural decisions for future consideration.

### 5.2 Auth Disabled by Default in Development
When `API_KEYS` is empty, all authentication is bypassed. This is intentional for local development but creates a footgun if dev config reaches a public environment. The `.env.example` sets a placeholder key (`your-api-key-here`) as a reminder.

### 5.3 In-Memory Audit Log
The RBAC audit log (`getAuditLog()`) is held in process memory and is not persisted. A process crash or restart loses all audit history. For compliance use cases, Loki push URL or database logging must be configured.

### 5.4 Moonpay Webhook Length Guard
`offramp/moonpay.ts` notes a `TODO` for a length guard in `verifyMoonpayWebhook` before calling `timingSafeEqual`. The middleware version in `webhookVerification.ts` includes proper length comparison (`timingSafeCompare` checks `a.length !== b.length` first). Callers should use the middleware version, not the `offramp/moonpay.ts` export directly.

### 5.5 Public Blockchain Transparency
All `FundingRecord` entries (source, target, amount, fee) are readable by anyone who queries the Soroban contract. This is inherent to public blockchains and should be communicated to users.

---

## 6. Security Review Cadence

| Review type | Frequency | Owner |
|-------------|-----------|-------|
| Dependency vulnerability scan | Weekly (automated, GitHub Actions) | DevOps |
| Threat model review | Quarterly or on significant architecture change | Security lead |
| Code security review (PRs to `main`) | Per PR | Engineering |
| Full external audit | Before mainnet launch and annually thereafter | External auditor |
| Secret rotation | On suspected compromise, or annually | Platform team |
| Contract audit | Before each major contract upgrade | External auditor |

---

## 7. Out of Scope

- Physical security of infrastructure
- Social engineering attacks against personnel
- Stellar network-level attacks (eclipse, long-range reorgs)
- Moonpay / Transak platform security (third-party responsibility)
- End-user wallet security
