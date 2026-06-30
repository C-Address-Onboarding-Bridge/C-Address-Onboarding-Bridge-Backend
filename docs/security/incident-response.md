# Security Incident Response Plan

**Project**: C-Address Onboarding Bridge  
**Last reviewed**: 2026-06-30  
**Owner**: Security lead / on-call engineer

---

## 1. Purpose and Scope

This plan describes how the team detects, responds to, and recovers from security incidents affecting the Onboarding Bridge API, smart contract, CI/CD pipeline, and supporting infrastructure. It covers:

- API server compromise or credential leakage
- Smart contract exploitation or unauthorized admin operations
- Webhook forgery or payment fraud
- Dependency supply-chain compromise
- Data leakage (API keys, wallet addresses, secrets)

---

## 2. Severity Levels

| Level | Description | Initial Response SLA |
|-------|-------------|----------------------|
| **P1 — Critical** | Active exploitation, funds at risk, contract admin key compromised, mainnet contract paused/drained | **15 minutes** |
| **P2 — High** | API key leaked, webhook secret compromised, rate limiting bypassed at scale, confidential data exposed | **1 hour** |
| **P3 — Medium** | Suspected (not confirmed) compromise, anomalous traffic, dependency vulnerability with known exploit | **4 hours** |
| **P4 — Low** | Informational finding, low-severity CVE in a dependency, anomalous log entry with no impact | **24 hours** |

---

## 3. Roles and Responsibilities

| Role | Responsibility |
|------|---------------|
| **Incident Commander (IC)** | Declares incident level, coordinates response, communicates status, approves public disclosure |
| **Security Lead** | Technical investigation, forensics, root cause analysis, patch review |
| **On-Call Engineer** | First responder, initial containment, deploys hotfixes |
| **Platform Team** | Infrastructure access (secrets rotation, Redis flush, container restart) |
| **Legal / Compliance** | Advises on regulatory notification requirements |
| **Communications Lead** | Drafts external notices, coordinates with Moonpay/Transak if applicable |

For a P1 incident, the IC must be reachable and engaged within 15 minutes of detection. The on-call rotation is the default first contact.

---

## 4. Detection Sources

| Source | What it detects |
|--------|----------------|
| GitHub Actions alerts | CI/CD anomalies, workflow injection attempts |
| Dependency audit workflow | Known CVEs in npm/Cargo dependencies |
| Prometheus / Alertmanager alerts | Spike in 401/403/429/500 rates, circuit breaker open, high latency |
| Pino logs (Loki) | Unusual patterns: mass auth failures, injection pattern hits, IP bans, webhook verification failures |
| Slack abuse alerts (`sendAbuseAlert`) | IP bans, cost limit exceeded, suspicious activity patterns |
| Stellar Expert / Soroban explorer | Unexpected contract calls, unauthorized fee withdrawals, contract paused |
| External reporter (responsible disclosure) | See `SECURITY.md` |

---

## 5. Incident Response Playbooks

### 5.1 API Key Compromised

**Indicators**: Unusual traffic from unfamiliar IPs, requests to unexpected endpoints, abuse alert for a specific `keyId`.

**Steps**:
1. **Detect**: Identify the `keyId` from logs or the abuse alert payload.
2. **Contain** (within 15 min for P1, 1 hr for P2):
   ```
   # Revoke the compromised key immediately
   # Via the admin API or directly in the key store
   POST /admin/keys/:id/revoke
   ```
   If the key store is in-memory and a process restart is required, restart the API server — all in-memory keys are wiped, and fresh keys must be re-issued.
3. **Assess**: Review the audit log (`getAuditLog()`) for all actions taken with the compromised key. Identify any `fund:write` or `admin:keys` scope usage.
4. **Investigate**: Check Loki/CloudWatch logs for the `keyId`. Determine if the key was used to initiate on-chain transactions (cross-reference Stellar Expert by source address).
5. **Remediate**: Issue replacement keys to the affected integrator. Notify them of the incident scope.
6. **Review**: Determine how the key was compromised (code leak, log exposure, insider). Patch the root cause before re-issuing.

---

### 5.2 Webhook Secret Compromised (Moonpay / Transak)

**Indicators**: Unexpected payment status changes, webhook verification failures from legitimate IPs (attacker probing the secret), abuse alert for webhook endpoint.

**Steps**:
1. **Contain**:
   - Rotate the webhook secret in the provider's dashboard (Moonpay: Settings → Webhooks; Transak: Dashboard → Webhooks).
   - Update `MOONPAY_SECRET_KEY` / `TRANSAK_WEBHOOK_SECRET` in the secrets manager and redeploy the API.
   - Temporarily disable webhook processing if the provider supports it.
2. **Assess**: Review all webhook events received in the past 24 hours. Cross-reference against Moonpay/Transak's transaction logs to identify any forged events that triggered state changes.
3. **Investigate**: Determine how the secret leaked (log exposure via `I-1` risk, git history, environment file).
4. **Remediate**: If any fraudulent on-ramp events were processed, work with Moonpay/Transak to identify affected transactions. Notify affected users.

---

### 5.3 Contract Admin Key Compromised

**Indicators**: Unexpected `propose` or `execute` transaction on Stellar Explorer from a known admin address, unsanctioned fee rate change, contract paused unexpectedly.

**Steps**:
1. **Detect**: Monitor the contract address on Stellar Expert for any admin-level transactions.
2. **Assess immediately**:
   ```bash
   # Check if the contract is paused
   stellar contract invoke --id $CONTRACT_ID ... -- is_paused
   # Check accumulated fees balance
   stellar contract invoke --id $CONTRACT_ID ... -- accumulated_fees
   # Check active proposals
   stellar contract invoke --id $CONTRACT_ID ... -- get_active_proposals
   ```
3. **Contain**:
   - Do **not** approve any pending proposals until the compromised key scope is understood.
   - If funds are at risk, use remaining uncompromised admin keys to submit a `Pause` proposal and reach threshold to pause the contract, halting further `fund_c_address` calls.
   - Rotate the compromised admin key: this requires deploying a new contract (Soroban contracts are immutable). If threshold is still achievable with remaining keys, the attacker cannot unilaterally execute proposals.
4. **Evaluate fee drain risk**: Check if a `WithdrawFees` proposal was executed. If so, the `withdrawn` event on-chain records the recipient address and amount.
5. **Remediate**: Deploy a new contract version with a replacement admin address set. Update `BRIDGE_CONTRACT_ID` in the API server and redeploy. Notify users of the migration.
6. **Post-incident**: Increase the approval threshold if the breach was due to single-key compromise.

---

### 5.4 Rate Limiting Bypassed / DDoS

**Indicators**: Sustained high request volume despite rate limits, Redis showing no matching keys for attacking IPs, service degradation.

**Steps**:
1. **Detect**: Prometheus alert (`rate_limit_high` runbook) or manual observation of 429 errors not correlating with slowdown.
2. **Contain**:
   - Confirm Redis is up: `redis-cli PING`. If down, rate limits are in-process (per-instance).
   - If Redis is up and limits are bypassed: examine the `keyGenerator` logic for edge cases (IPv6, proxy headers, `X-Forwarded-For` spoofing).
   - Emergency: add the attacking IP ranges to an upstream WAF or ingress deny-list.
3. **Assess**: Determine if the attacker reached any fund endpoints (10 req/min limit) or caused downstream RPC circuit breaker trips.
4. **Remediate**: Fix the rate limiter bypass. Deploy. Monitor recovery.

---

### 5.5 Dependency Supply-Chain Compromise

**Indicators**: Automated dependency audit workflow reports a new critical/high CVE; a malicious package is published with the same name as a dependency (typosquatting); maintainer account takeover.

**Steps**:
1. **Assess severity**: Is the vulnerable code reachable from the API attack surface? Is there a known exploit?
2. **Contain** (critical CVE with known exploit):
   - Freeze deployments until patched.
   - If the compromised package is already in production, evaluate whether it could have been exploited since it was deployed.
3. **Patch**:
   ```bash
   npm audit fix          # for npm dependencies
   cargo audit fix        # for Cargo dependencies (if available)
   # Or manually update the specific package in package.json / Cargo.toml
   ```
4. **Deploy**: Fast-track through the standard deployment pipeline. CI tests must pass.
5. **Review**: Check if the patch SLAs from the dependency audit policy were met (critical: 24 hrs, high: 7 days). Document any override in the issue tracker.

---

### 5.6 CI/CD Pipeline Compromise (Workflow Injection)

**Indicators**: Unexpected workflow runs, secrets accessed by a workflow that should not have access, unusual git operations in CI, new unknown commits on protected branches.

**Steps**:
1. **Contain**:
   - Immediately rotate all GitHub Actions secrets: `SOROBAN_SOURCE_ACCOUNT`, `SOROBAN_SOURCE_ACCOUNT_MAINNET`, `CONTRACT_ADMIN_ADDRESSES*`, `SLACK_WEBHOOK_URL`.
   - Revoke all API keys that may have been visible to CI (check if any keys are in plaintext in the repo or step outputs).
   - Disable any workflows suspected of being modified by the attacker (Settings → Actions → Disable).
2. **Assess**:
   - Review GitHub Actions audit log (Settings → Audit log) for unusual workflow triggers, secret access, or environment approvals.
   - Check if any deployment to mainnet was triggered without the required reviewer approvals.
   - Verify `deployments/deployment-mainnet.json` — compare `wasmHash` against a locally-built binary.
3. **Remediate**:
   - Re-audit all workflow files for injected steps or modified `uses:` actions.
   - Enforce `permissions: read-all` as the default workflow-level permission and grant write only where required.
   - Add branch protection rules preventing force-pushes to `.github/workflows/`.

---

## 6. Containment Quick Reference

| Scenario | Immediate action |
|----------|-----------------|
| API key leaked | `POST /admin/keys/:id/revoke` or restart process |
| Webhook secret leaked | Rotate in provider dashboard + redeploy API |
| Contract admin key leaked | Submit `Pause` proposal with remaining keys |
| DDoS active | Add attacking IPs to WAF / ingress deny-list |
| Contract draining ongoing | Pause the contract via multi-sig |
| Malicious npm package | `npm audit fix` + freeze deployments |
| CI/CD breach | Rotate all GitHub secrets + disable affected workflows |
| Redis compromised | Flush Redis + restart API (in-memory fallback) + investigate |

---

## 7. Post-Incident Process

All P1 and P2 incidents, and P3 incidents with confirmed impact, require a post-mortem within **5 business days** of resolution.

### Post-Mortem Template

```
## Incident Summary
- Date/time of detection:
- Date/time of resolution:
- Duration:
- Severity:
- Incident Commander:

## Timeline
(UTC timestamps for each key event)

## Root Cause
(What was the underlying technical cause?)

## Impact
- Users affected:
- Funds at risk or affected:
- Data exposed:
- Downtime:

## What Went Well

## What Went Wrong

## Action Items
| Action | Owner | Due date |
|--------|-------|----------|
|        |       |          |

## Lessons Learned
```

Post-mortems are blameless. The goal is systemic improvement, not attribution.

---

## 8. Communication Templates

### Internal Alert (Slack / Pager)
```
🚨 SECURITY INCIDENT — P{level}
Summary: {one-line description}
Detected: {timestamp}
IC: {name}
Status: {investigating / containing / resolved}
Bridge: {thread link}
```

### External User Notice (P1/P2 affecting users)
```
Subject: Security Notice — C-Address Onboarding Bridge

We are writing to inform you of a security incident that may have affected
your use of the C-Address Onboarding Bridge.

What happened: {description without operational details}
When: {date range}
What was affected: {scope}
What we have done: {containment steps taken}
What you should do: {user actions, e.g., rotate API keys}

We take security seriously and are committed to transparency.
If you have questions, contact security@{project-domain}.
```

### Provider Notice (Moonpay / Transak)
Contact via the provider's security email or support dashboard. Include:
- Incident reference number
- Approximate time window
- Whether forged webhooks may have been accepted
- Request for their transaction logs for the time window

---

## 9. Related Documents

- [Threat Model](threat-model.md)
- [SECURITY.md](../../SECURITY.md) — responsible disclosure policy
- [Runbooks](../runbooks/) — operational response for specific alerts
- [Disaster Recovery](../disaster-recovery.md) — infrastructure recovery procedures
- [Secrets Management](../secrets-management.md) — secret rotation procedures
- [ADR-009: Security Architecture](../adr/adr-009-security-architecture.md)
