# Runbook: Circuit Breaker Open

**Alert:** `CircuitBreakerOpen`  
**Severity:** Critical

## What is happening

A circuit breaker for an external service has been in OPEN state for >5 minutes, meaning that service is being bypassed entirely.

## Investigation Steps

1. Identify which service: check `$labels.service` in the alert
2. Check the service directly:
   - **Moonpay**: `curl https://api.moonpay.com/v3/health`
   - **Transak**: `curl https://global-stg.transak.com/api/v1/health`
   - **Soroban RPC**: `curl $SOROBAN_RPC_URL`
3. Check circuit breaker metrics in Grafana System Health dashboard

## Remediation

- If external service is back: the half-open probe will reset automatically (default 30s)
- To force reset: `kubectl exec -it <pod> -- curl -X POST localhost:3001/internal/circuit-breaker/reset`
- If service is experiencing an extended outage: create a maintenance window silence in Alertmanager
