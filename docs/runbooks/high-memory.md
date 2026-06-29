# Runbook: High Memory Usage

**Alerts:** `HighMemoryUsage`, `HighMemoryUsageCritical`  
**Severity:** Warning / Critical

## Investigation Steps

1. Check current memory: `kubectl top pods -l app=c-address-bridge`
2. Check for memory leaks in logs: look for "heap" or "memory" errors
3. Check if in-memory cache is unbounded: `api/src/services/cache.ts`
4. Profile if persistent: attach a Node.js heap snapshot

## Remediation

- **Warning**: monitor, no immediate action
- **Critical**: restart pod to reclaim memory: `kubectl rollout restart deployment/c-address-bridge`
- Long-term: tune cache max size, add memory limits to container spec
