# Runbook: High Latency

**Alert:** `HighP99Latency`  
**Severity:** Critical  
**Dashboard:** [System Health](http://grafana:3000/d/cab-system-health)

## What is happening

The p99 request latency has exceeded 2 seconds over a 5-minute window.

## Investigation Steps

1. **Check slow queries** — look at `pg_stat_statements` or slow query log
   ```sql
   SELECT query, mean_exec_time, calls
   FROM pg_stat_statements
   ORDER BY mean_exec_time DESC LIMIT 20;
   ```

2. **Check Soroban RPC latency** — in DeFi Operations dashboard

3. **Check connection pool saturation**
   ```bash
   # pgbouncer admin console
   psql -h localhost -p 6432 -U pgbouncer pgbouncer -c "SHOW POOLS;"
   ```

4. **Check cache hit ratio** — low cache hit ratio can inflate latency

## Remediation

- If DB slow query: ensure indexes exist (see migration 005)
- If RPC latency: check Soroban node health, consider switching RPC endpoint in pool
- If pool exhaustion: increase `pool_size` in pgbouncer config and restart
