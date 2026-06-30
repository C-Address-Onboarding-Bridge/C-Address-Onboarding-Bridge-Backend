# Runbook: Health Endpoint Down

**Alert:** `HealthEndpointDown`  
**Severity:** Critical

## What is happening

The `/health` endpoint is not responding to blackbox probes.

## Investigation Steps

1. **Manual probe**: `curl -v https://<host>/health`
2. **Check pod status**: `kubectl get pods -l app=c-address-bridge`
3. **Check recent events**: `kubectl describe pod <pod-name>`
4. **Check logs**: `kubectl logs <pod-name> --previous`

## Remediation

- Restart pod: `kubectl rollout restart deployment/c-address-bridge`
- If persistent: roll back to previous image
