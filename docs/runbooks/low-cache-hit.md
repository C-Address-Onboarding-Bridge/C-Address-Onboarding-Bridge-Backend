# Runbook: Low Cache Hit Ratio

**Alert:** `LowCacheHitRatio`  
**Severity:** Warning

## What is happening

The in-process cache hit ratio has dropped below 50% for >15 minutes.

## Investigation Steps

1. Check if the application recently restarted (cold cache is expected after restart)
2. Check cache size configuration in `api/src/services/cache.ts`
3. Check if request patterns have changed significantly (new API clients?)

## Remediation

- If recently restarted: alert will self-resolve as cache warms up
- If sustained: consider increasing cache TTL or size limits
- No immediate user impact expected; this affects latency only
