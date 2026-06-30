#!/usr/bin/env bash
# rollback-contract.sh — Roll back an Onboarding Bridge contract deployment
#
# Strategy: Soroban contracts are immutable once deployed. "Rolling back" means
# pointing your infrastructure back at a previously-deployed contract ID from a
# saved artifact, then verifying it is still live.
#
# Steps:
#   1. Load the rollback target artifact (.prev.json or a specified version)
#   2. Verify the previous contract is still live on-chain
#   3. Swap the active artifact back to the previous version
#   4. Print the rollback contract ID for operators to update env vars
#   5. Optionally notify Slack
#
# Usage:
#   SOURCE_ACCOUNT=S... bash scripts/rollback-contract.sh [OPTIONS]
#
# Options:
#   --network   testnet|mainnet|custom  (default: testnet)
#   --artifact  path/to/artifact.json  (default: deployments/deployment-<network>.prev.json)
#   --list      list available rollback targets and exit
#   --dry-run   validate and print the rollback target without swapping artifacts
#
# Required env vars:
#   SOURCE_ACCOUNT — Stellar secret key (S...) for on-chain verification calls
#
# Optional env vars:
#   SOROBAN_RPC_URL
#   SOROBAN_NETWORK_PASSPHRASE
#   SLACK_WEBHOOK_URL
#   GITHUB_OUTPUT — if set, writes contract_id and wasm_hash outputs

set -euo pipefail

# ── defaults ──────────────────────────────────────────────────────────────────
NETWORK="${NETWORK:-testnet}"
ARTIFACT_OVERRIDE=""
DRY_RUN=false
LIST_ONLY=false
ARTIFACTS_DIR="deployments"
ROLLBACK_CONTRACT_ID=""
ROLLBACK_WASM_HASH=""

# ── parse args ────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --network)  NETWORK="$2";           shift 2 ;;
    --artifact) ARTIFACT_OVERRIDE="$2"; shift 2 ;;
    --dry-run)  DRY_RUN=true;           shift   ;;
    --list)     LIST_ONLY=true;         shift   ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

# ── network config ────────────────────────────────────────────────────────────
case "$NETWORK" in
  testnet)
    RPC_URL="${SOROBAN_RPC_URL:-https://soroban-rpc.testnet.stellar.org}"
    NETWORK_PASSPHRASE="${SOROBAN_NETWORK_PASSPHRASE:-Test SDF Network ; September 2015}"
    EXPLORER_CONTRACT="https://stellar.expert/explorer/testnet/contract"
    ;;
  mainnet)
    RPC_URL="${SOROBAN_RPC_URL:-https://mainnet.sorobanrpc.com}"
    NETWORK_PASSPHRASE="${SOROBAN_NETWORK_PASSPHRASE:-Public Global Stellar Network ; September 2015}"
    EXPLORER_CONTRACT="https://stellar.expert/explorer/public/contract"
    ;;
  custom)
    RPC_URL="${SOROBAN_RPC_URL:?SOROBAN_RPC_URL required for custom network}"
    NETWORK_PASSPHRASE="${SOROBAN_NETWORK_PASSPHRASE:?SOROBAN_NETWORK_PASSPHRASE required for custom network}"
    EXPLORER_CONTRACT=""
    ;;
  *)
    echo "ERROR: unknown network '$NETWORK'." >&2; exit 1 ;;
esac

: "${SOURCE_ACCOUNT:?SOURCE_ACCOUNT (Stellar secret key S...) is required}"

# ── helpers ───────────────────────────────────────────────────────────────────
log()     { echo "[$(date -u +%H:%M:%SZ)] $*"; }
log_ok()  { echo "[$(date -u +%H:%M:%SZ)] ✓ $*"; }
log_err() { echo "[$(date -u +%H:%M:%SZ)] ✗ ERROR: $*" >&2; exit 1; }
log_warn(){ echo "[$(date -u +%H:%M:%SZ)] ⚠ WARN: $*" >&2; }

# ── list available rollback targets ──────────────────────────────────────────
list_targets() {
  log "Available rollback artifacts for network=$NETWORK:"
  local found=false
  for f in "${ARTIFACTS_DIR}"/deployment-"${NETWORK}"*.json; do
    [[ -f "$f" ]] || continue
    found=true
    local id ts tag
    id=$(jq -r '.contractId // "unknown"' "$f" 2>/dev/null)
    ts=$(jq -r '.deployedAt // "unknown"' "$f" 2>/dev/null)
    tag=$(jq -r '.gitTag // ""' "$f" 2>/dev/null)
    echo "  $(basename "$f")  contract=$id  deployed=$ts  tag=${tag:-<untagged>}"
  done
  $found || log "No artifacts found in ${ARTIFACTS_DIR}/ for network=${NETWORK}."
}

# ── resolve rollback artifact ─────────────────────────────────────────────────
resolve_artifact() {
  if [[ -n "$ARTIFACT_OVERRIDE" ]]; then
    ROLLBACK_ARTIFACT="$ARTIFACT_OVERRIDE"
  else
    # Default: the .prev.json saved by the last deploy
    ROLLBACK_ARTIFACT="${ARTIFACTS_DIR}/deployment-${NETWORK}.prev.json"
  fi

  [[ -f "$ROLLBACK_ARTIFACT" ]] \
    || log_err "Rollback artifact not found: $ROLLBACK_ARTIFACT
Use --artifact <path> to specify one, or --list to see available artifacts."

  ROLLBACK_CONTRACT_ID=$(jq -r '.contractId // empty' "$ROLLBACK_ARTIFACT")
  ROLLBACK_WASM_HASH=$(jq -r '.wasmHash // "unknown"' "$ROLLBACK_ARTIFACT")
  local deployed_at
  deployed_at=$(jq -r '.deployedAt // "unknown"' "$ROLLBACK_ARTIFACT")
  local git_tag
  git_tag=$(jq -r '.gitTag // ""' "$ROLLBACK_ARTIFACT")

  [[ -n "$ROLLBACK_CONTRACT_ID" ]] \
    || log_err "No contractId found in $ROLLBACK_ARTIFACT"

  log "Rollback target:"
  log "  Contract ID:  $ROLLBACK_CONTRACT_ID"
  log "  WASM SHA-256: $ROLLBACK_WASM_HASH"
  log "  Deployed at:  $deployed_at"
  log "  Git tag:      ${git_tag:-<untagged>}"
  [[ -n "$EXPLORER_CONTRACT" ]] \
    && log "  Explorer:     ${EXPLORER_CONTRACT}/${ROLLBACK_CONTRACT_ID}"
}

# ── verify rollback target is still live ─────────────────────────────────────
verify_rollback_target() {
  log "Verifying rollback target is live on-chain..."
  local version
  if version=$(stellar contract invoke \
      --id "$ROLLBACK_CONTRACT_ID" \
      --rpc-url "$RPC_URL" \
      --network-passphrase "$NETWORK_PASSPHRASE" \
      --source "$SOURCE_ACCOUNT" \
      -- version 2>&1); then
    log_ok "Rollback contract is live (version=$version)."
  else
    log_err "Rollback contract $ROLLBACK_CONTRACT_ID is NOT responding on $NETWORK.
The contract may have expired or the network may be unavailable.
Output: $version"
  fi
}

# ── swap artifacts ────────────────────────────────────────────────────────────
swap_artifacts() {
  local current="${ARTIFACTS_DIR}/deployment-${NETWORK}.json"
  local ts
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  # Archive the current (failed) deployment before overwriting
  if [[ -f "$current" ]]; then
    local rolled_out="${ARTIFACTS_DIR}/deployment-${NETWORK}.rolledback-${ts//[:TZ]/-}.json"
    cp "$current" "$rolled_out"
    log "Current (rolled-back) artifact archived: $rolled_out"
  fi

  # Write a rollback record: copy the target artifact and add a rollback timestamp
  jq --arg rolledBackAt "$ts" \
     --arg rolledBackFrom "${current}" \
     '. + {rolledBackAt: $rolledBackAt, note: "Artifact restored by rollback procedure"}' \
     "$ROLLBACK_ARTIFACT" > "$current"

  cp "$current" "${ARTIFACTS_DIR}/deployment-latest.json"
  log_ok "Active artifact restored to rollback target."
}

# ── notify Slack ──────────────────────────────────────────────────────────────
notify_slack() {
  [[ -z "${SLACK_WEBHOOK_URL:-}" ]] && return

  local actor="${GITHUB_ACTOR:-$(whoami)}"
  local run_url=""
  if [[ -n "${GITHUB_SERVER_URL:-}" && -n "${GITHUB_REPOSITORY:-}" && -n "${GITHUB_RUN_ID:-}" ]]; then
    run_url="${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}"
  fi

  local payload
  payload=$(jq -n \
    --arg network    "$NETWORK" \
    --arg contractId "$ROLLBACK_CONTRACT_ID" \
    --arg actor      "$actor" \
    --arg runUrl     "$run_url" \
    '{
      text: "⏪ Contract *rollback* on \($network)",
      blocks: [{
        type: "section", text: {type: "mrkdwn",
        text: "⏪ *Rollback executed on \($network)*\nRestored contract: `\($contractId)`\nBy: `\($actor)`\nRun: \(if $runUrl != "" then "<\($runUrl)|View>" else "manual" end)"
      }}]
    }')

  curl -sf -X POST -H "Content-Type: application/json" \
    -d "$payload" "$SLACK_WEBHOOK_URL" > /dev/null \
    && log_ok "Slack notification sent." \
    || log_warn "Slack notification failed (non-fatal)."
}

# ── main ──────────────────────────────────────────────────────────────────────
main() {
  log "═══════════════════════════════════════════════════"
  log "  Onboarding Bridge — Contract Rollback Procedure"
  log "═══════════════════════════════════════════════════"
  log "Network: $NETWORK"
  log "Dry run: $DRY_RUN"
  log "───────────────────────────────────────────────────"

  if $LIST_ONLY; then
    list_targets
    exit 0
  fi

  resolve_artifact
  verify_rollback_target

  if $DRY_RUN; then
    log "DRY RUN — verified rollback target. No artifacts were modified."
    log "To apply: rerun without --dry-run."
    exit 0
  fi

  swap_artifacts
  notify_slack

  log "───────────────────────────────────────────────────"
  log_ok "Rollback complete."
  log    "CONTRACT_ID=$ROLLBACK_CONTRACT_ID"
  log    ""
  log    "⚠  IMPORTANT: Update your service configuration to use the"
  log    "   restored contract ID: $ROLLBACK_CONTRACT_ID"
  log    "   Set: BRIDGE_CONTRACT_ID=$ROLLBACK_CONTRACT_ID"
  log    "   Then redeploy the API server."
  log "───────────────────────────────────────────────────"

  # Export for GitHub Actions
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    echo "contract_id=${ROLLBACK_CONTRACT_ID}" >> "$GITHUB_OUTPUT"
    echo "wasm_hash=${ROLLBACK_WASM_HASH}"     >> "$GITHUB_OUTPUT"
    echo "network=${NETWORK}"                  >> "$GITHUB_OUTPUT"
  fi
}

main
