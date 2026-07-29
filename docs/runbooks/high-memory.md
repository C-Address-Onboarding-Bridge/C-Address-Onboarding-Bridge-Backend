# Runbook: High Memory Usage

**Alerts:** `HighMemoryUsage`, `HighMemoryUsageCritical`  
**Severity:** Warning / Critical

## Investigation Steps

1. Check current memory: `ssh "$DEPLOY_USER@$DEPLOY_HOST" "systemctl status c-address-bridge | grep Memory"`
2. Check for memory leaks in logs: look for "heap" or "memory" errors
3. Check if in-memory cache is unbounded: `api/src/services/cache.ts`
4. Profile if persistent: attach a Node.js heap snapshot

## Remediation

- **Warning**: monitor, no immediate action
- **Critical**: restart service to reclaim memory: `ssh "$DEPLOY_USER@$DEPLOY_HOST" "sudo systemctl restart c-address-bridge"`
- Long-term: tune cache max size, add memory limits to container spec
