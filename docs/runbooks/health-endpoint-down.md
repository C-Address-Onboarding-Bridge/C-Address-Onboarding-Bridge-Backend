# Runbook: Health Endpoint Down

**Alert:** `HealthEndpointDown`  
**Severity:** Critical

## What is happening

The `/health` endpoint is not responding to blackbox probes.

## Investigation Steps

1. **Manual probe**: `curl -v https://<host>/health`
2. **Check service status**: `ssh "$DEPLOY_USER@$DEPLOY_HOST" "systemctl status c-address-bridge"`
3. **Check recent events**: `ssh "$DEPLOY_USER@$DEPLOY_HOST" "journalctl -u c-address-bridge -n 100 --no-pager"`
4. **Check logs**: `ssh "$DEPLOY_USER@$DEPLOY_HOST" "journalctl -u c-address-bridge --since '-30min'"`

## Remediation

- Restart service: `ssh "$DEPLOY_USER@$DEPLOY_HOST" "sudo systemctl restart c-address-bridge"`
- If persistent: roll back to previous image
