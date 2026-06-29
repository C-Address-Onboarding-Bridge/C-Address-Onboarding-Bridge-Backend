# Runbook: SLO Error Budget Burn

**Alerts:** `SLOFastBurn`, `SLOSlowBurn`  
**Severity:** Critical / Warning

## What is happening

The monthly 99.9% availability SLO error budget is being consumed faster than allowed.

- **Fast burn** (14.4×): At this rate, the monthly budget is exhausted in ~2 hours. Immediate action required.
- **Slow burn** (6×): Budget will be exhausted in ~5 days. Investigate and resolve soon.

## Investigation Steps

1. Open the Alerts & SLO dashboard for burn rate trend
2. Identify which routes are producing errors — check `HighErrorRate` alert
3. Correlate with recent deployments or external service degradations

## Remediation

Follow the `high-error-rate` runbook to resolve the underlying error source.

## Notes

SLO target: 99.9% monthly availability (43.8 min/month error budget).
