# Runbook: Rate Limit Usage High

**Alert:** `RateLimitUsageHigh`  
**Severity:** Warning

## What is happening

More than 80% of incoming requests are being rate-limited, indicating potential abuse or a very high traffic spike.

## Investigation Steps

1. Check which client IPs or API keys are being rate-limited:
   ```bash
   kubectl logs -l app=c-address-bridge | grep "rate_limit" | awk '{print $NF}' | sort | uniq -c | sort -rn | head -20
   ```
2. Determine if this is legitimate load or abuse

## Remediation

- If abuse: block the offending IP at the load balancer / WAF level
- If legitimate traffic spike: consider temporarily increasing rate limits in `api/src/middleware/rateLimit.ts`
- If CDN is misconfigured: ensure cached responses don't bypass rate limiting
