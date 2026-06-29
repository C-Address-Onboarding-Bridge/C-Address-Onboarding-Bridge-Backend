# Runbook: High Error Rate

**Alert:** `HighErrorRate`
**Severity:** Critical
**Dashboard:** [System Health](http://grafana:3000/d/cab-system-health)

## What is happening

The HTTP 5xx error rate for the C-Address Bridge API has exceeded 5% over a 5-minute window.

## Impact

Users cannot complete funding transactions or receive quotes. Revenue impact begins immediately.

## Investigation Steps

1. **Check recent deployments**
   ```bash
   git log --oneline -10
   kubectl rollout history deployment/c-address-bridge
   ```

2. **Inspect error logs**
   ```bash
   kubectl logs -l app=c-address-bridge --tail=200 | grep '"level":"error"'
   ```

3. **Check downstream services** — Soroban RPC, Moonpay, Transak, database
   - Soroban RPC: `curl $SOROBAN_RPC_URL/health`
   - Check circuit breaker states in Grafana

4. **Check database connectivity**
   ```bash
   kubectl exec -it <api-pod> -- node -e "require('./dist/services/db').db.raw('SELECT 1')"
   ```

## Remediation

- If a bad deploy: `kubectl rollout undo deployment/c-address-bridge`
- If a downstream outage: circuit breakers should open automatically; verify in dashboard
- If DB connectivity: check pgbouncer pool exhaustion, restart if needed

## Escalation

Page the on-call engineer if unresolved after 10 minutes.
