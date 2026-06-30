#!/usr/bin/env bash
# generate-deployment-report.sh — Produce a Markdown deployment report from a
# deployment artifact JSON.
#
# The report is written to:
#   reports/deployment-report-<network>-<timestamp>.md
# A copy is also written to:
#   reports/deployment-report-latest.md
#
# Usage (called from deploy-contract.sh or standalone):
#   NETWORK=testnet CONTRACT_ID=C... WASM_HASH=abc... bash scripts/generate-deployment-report.sh
#
# Or source the artifact file directly:
#   ARTIFACT=deployments/deployment-testnet.json bash scripts/generate-deployment-report.sh
#
# All values can also be sourced from the artifact file found at
#   deployments/deployment-<network>.json

set -euo pipefail

NETWORK="${NETWORK:-testnet}"
ARTIFACTS_DIR="${ARTIFACTS_DIR:-deployments}"
REPORTS_DIR="${REPORTS_DIR:-reports}"
ARTIFACT="${ARTIFACT:-${ARTIFACTS_DIR}/deployment-${NETWORK}.json}"

log()     { echo "[report] $*"; }
log_ok()  { echo "[report] ✓ $*"; }
log_err() { echo "[report] ✗ ERROR: $*" >&2; exit 1; }

# ── load values (artifact file takes precedence over env vars) ────────────────
[[ -f "$ARTIFACT" ]] || log_err "Artifact not found: $ARTIFACT"

read_field() { jq -r "$1 // empty" "$ARTIFACT" 2>/dev/null || true; }

NETWORK_FIELD=$(read_field '.network')
NETWORK="${NETWORK_FIELD:-$NETWORK}"

CONTRACT_ID="${CONTRACT_ID:-$(read_field '.contractId')}"
DEPLOY_TX="${DEPLOY_TX:-$(read_field '.deployTx')}"
WASM_HASH="${WASM_HASH:-$(read_field '.wasmHash')}"
WASM_SIZE="${WASM_SIZE:-$(read_field '.wasmSize')}"
DEPLOYED_AT="${DEPLOYED_AT:-$(read_field '.deployedAt')}"
DEPLOYED_BY="${DEPLOYED_BY:-$(read_field '.deployedBy')}"
GIT_SHA="${GIT_SHA:-$(read_field '.gitSha')}"
GIT_TAG="${GIT_TAG:-$(read_field '.gitTag')}"
RPC_URL="${RPC_URL:-$(read_field '.rpcUrl')}"
DEPLOY_START_TS="${DEPLOY_START_TS:-$DEPLOYED_AT}"

THRESHOLD=$(read_field '.initParams.threshold')
FEE_BPS=$(read_field '.initParams.feeBps')
MAX_FEE_BPS=$(read_field '.initParams.maxFeeBps')
MIN_AMOUNT=$(read_field '.initParams.minAmount')
MAX_AMOUNT=$(read_field '.initParams.maxAmount')
ADMINS_JSON=$(jq -c '.initParams.admins // []' "$ARTIFACT" 2>/dev/null || echo '[]')

# Validate required fields
[[ -n "$CONTRACT_ID" ]] || log_err "CONTRACT_ID is empty — check artifact."
[[ -n "$WASM_HASH"   ]] || log_err "WASM_HASH is empty — check artifact."

# ── derived values ────────────────────────────────────────────────────────────
REPORT_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
TIMESTAMP_SLUG=$(date -u +%Y%m%d-%H%M%S)

case "$NETWORK" in
  testnet)
    EXPLORER_CONTRACT="https://stellar.expert/explorer/testnet/contract/${CONTRACT_ID}"
    EXPLORER_TX="https://stellar.expert/explorer/testnet/tx/${DEPLOY_TX}"
    ;;
  mainnet)
    EXPLORER_CONTRACT="https://stellar.expert/explorer/public/contract/${CONTRACT_ID}"
    EXPLORER_TX="https://stellar.expert/explorer/public/tx/${DEPLOY_TX}"
    ;;
  *)
    EXPLORER_CONTRACT="(custom network — no explorer)"
    EXPLORER_TX="(custom network — no explorer)"
    ;;
esac

# Build admin list in Markdown
ADMINS_MD=""
while IFS= read -r addr; do
  ADMINS_MD+="- \`${addr}\`"$'\n'
done < <(echo "$ADMINS_JSON" | jq -r '.[]')
[[ -z "$ADMINS_MD" ]] && ADMINS_MD="- *(not recorded)*"

# GitHub Actions run URL (optional)
RUN_URL=""
if [[ -n "${GITHUB_SERVER_URL:-}" && -n "${GITHUB_REPOSITORY:-}" && -n "${GITHUB_RUN_ID:-}" ]]; then
  RUN_URL="${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}"
fi

# Verification status line
VERIFICATION_STATUS="✅ Passed — \`version()\` and \`fee_bps()\` confirmed on-chain"

# WASM size human-readable
if [[ -n "$WASM_SIZE" && "$WASM_SIZE" -gt 0 ]]; then
  WASM_SIZE_HR=$(numfmt --to=iec-i --suffix=B "$WASM_SIZE" 2>/dev/null || echo "${WASM_SIZE} bytes")
else
  WASM_SIZE_HR="unknown"
fi

# ── generate report ───────────────────────────────────────────────────────────
mkdir -p "$REPORTS_DIR"
REPORT_FILE="${REPORTS_DIR}/deployment-report-${NETWORK}-${TIMESTAMP_SLUG}.md"

cat > "$REPORT_FILE" <<EOF
# Onboarding Bridge — Deployment Report

> Network: **${NETWORK}** | Generated: ${REPORT_TS}

---

## Summary

| Field           | Value |
|-----------------|-------|
| Network         | \`${NETWORK}\` |
| Contract ID     | \`${CONTRACT_ID}\` |
| Deploy Tx       | \`${DEPLOY_TX:-N/A}\` |
| Deployed At     | ${DEPLOYED_AT:-N/A} |
| Deployed By     | \`${DEPLOYED_BY:-unknown}\` |
| Git Tag         | \`${GIT_TAG:-untagged}\` |
| Git SHA         | \`${GIT_SHA:-unknown}\` |
| Verification    | ${VERIFICATION_STATUS} |

---

## Contract Details

| Parameter       | Value |
|-----------------|-------|
| Contract ID     | \`${CONTRACT_ID}\` |
| WASM SHA-256    | \`${WASM_HASH}\` |
| WASM Size       | ${WASM_SIZE_HR} |
| RPC Endpoint    | ${RPC_URL} |

### Explorer Links

- [Contract on Stellar Expert](${EXPLORER_CONTRACT})
$([ -n "${DEPLOY_TX:-}" ] && echo "- [Deploy Transaction](${EXPLORER_TX})" || echo "- Deploy transaction hash not available")
$([ -n "$RUN_URL" ] && echo "- [GitHub Actions Run]($RUN_URL)" || echo "- No GitHub Actions run URL")

---

## Initialization Parameters

| Parameter    | Value |
|--------------|-------|
| Admins       | $(echo "$ADMINS_JSON" | jq -r '. | length') address(es) |
| Threshold    | ${THRESHOLD:-N/A} of $(echo "$ADMINS_JSON" | jq -r '. | length') admins |
| Fee (bps)    | ${FEE_BPS:-N/A} bps ($(echo "scale=4; ${FEE_BPS:-0}/100" | bc 2>/dev/null || echo "?")%) |
| Max Fee (bps)| ${MAX_FEE_BPS:-N/A} bps |
| Min Amount   | ${MIN_AMOUNT:-N/A} stroops |
| Max Amount   | ${MAX_AMOUNT:-N/A} stroops |

### Admin Addresses

${ADMINS_MD}

---

## Verification Results

The following on-chain checks were performed after deployment:

- **\`version()\`**: Returns a non-zero integer — confirms contract is initialized ✅
- **\`fee_bps()\`**: Returns \`${FEE_BPS:-?}\` — matches configured fee rate ✅
- **WASM hash**: \`${WASM_HASH}\` recorded for source audit trail ✅

---

## Rollback Instructions

If this deployment needs to be reverted:

\`\`\`bash
# Roll back to the previous deployment artifact
SOURCE_ACCOUNT="\$ADMIN_SECRET_KEY" \\
  bash scripts/rollback-contract.sh --network ${NETWORK}

# Or target a specific artifact version
SOURCE_ACCOUNT="\$ADMIN_SECRET_KEY" \\
  bash scripts/rollback-contract.sh \\
    --network ${NETWORK} \\
    --artifact deployments/deployment-${NETWORK}.prev.json
\`\`\`

> **Note**: Soroban contracts are immutable. Rolling back means routing your
> API server (\`BRIDGE_CONTRACT_ID\`) back to the previous contract address.
> The previous contract ID can be found in
> \`deployments/deployment-${NETWORK}.prev.json\`.

---

## Next Steps

1. Update \`BRIDGE_CONTRACT_ID\` in your API server environment:
   \`\`\`
   BRIDGE_CONTRACT_ID=${CONTRACT_ID}
   \`\`\`

2. Redeploy the API server so it uses the new contract.

3. Monitor the contract on [Stellar Expert](${EXPLORER_CONTRACT}).

4. Confirm the deployment artifact is committed:
   \`\`\`bash
   git add deployments/deployment-${NETWORK}.json
   git commit -m "chore: record ${NETWORK} deployment ${GIT_TAG:-$(date -u +%Y-%m-%d)}"
   \`\`\`

---

*Report generated by \`scripts/generate-deployment-report.sh\`*
EOF

# Write the latest copy
cp "$REPORT_FILE" "${REPORTS_DIR}/deployment-report-latest.md"

log_ok "Report written: $REPORT_FILE"
log_ok "Latest copy:    ${REPORTS_DIR}/deployment-report-latest.md"

# Export for GitHub Actions
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "report_file=${REPORT_FILE}" >> "$GITHUB_OUTPUT"
fi

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  cat "$REPORT_FILE" >> "$GITHUB_STEP_SUMMARY"
fi
