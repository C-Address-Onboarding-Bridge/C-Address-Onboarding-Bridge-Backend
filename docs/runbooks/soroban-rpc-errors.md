# Runbook: Soroban RPC Errors

**Alert:** `SorobanRPCHighErrorRate`  
**Severity:** Critical

## What is happening

More than 10% of Soroban RPC calls are failing. Contract interactions may be failing.

## Investigation Steps

1. **Check RPC node health**:
   ```bash
   curl $SOROBAN_RPC_URL/health
   ```
2. **Check RPC pool status** in DeFi Operations dashboard
3. **Check error types** in logs:
   ```bash
   kubectl logs -l app=c-address-bridge | grep "soroban" | grep "error"
   ```
4. **Check Stellar network status**: https://status.stellar.org

## Remediation

- If a single node is failing: the RPC pool will route around it automatically
- If all nodes are failing: check `SOROBAN_RPC_URL` env var and network passphrase
- If network-wide issue: wait for Stellar network recovery; no action needed

## Escalation

If the Soroban network is healthy but errors persist, escalate to the blockchain team.
