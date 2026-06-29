#!/usr/bin/env bash
# Contract deployment automation script for C-Address Onboarding Bridge
# Usage: ./scripts/deploy.sh [--network testnet|mainnet|custom] [--dry-run] [--skip-build]

set -euo pipefail

# ── defaults ─────────────────────────────────────────────────────────────────
NETWORK="${NETWORK:-testnet}"
ENVIRONMENT="${ENVIRONMENT:-}"   # dev | staging | production (optional, sets env-specific defaults)
DRY_RUN=false
SKIP_BUILD=false
ROLLBACK=false
ROLLBACK_STEPS="${STEPS:-1}"
ARTIFACTS_DIR="deployments"
ARTIFACT_FILE=""
CONTRACT_DIR="contracts/onboarding-bridge"

# ── parse args ───────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --network)    NETWORK="$2";         shift 2 ;;
    --dry-run)    DRY_RUN=true;         shift   ;;
    --skip-build) SKIP_BUILD=true;      shift   ;;
    --rollback)   ROLLBACK=true;        shift   ;;
    --steps)      ROLLBACK_STEPS="$2";  shift 2 ;;
    *) echo "Unknown flag: $1"; exit 1 ;;
  esac
done

# ── environment-specific config ───────────────────────────────────────────────
# ENVIRONMENT overrides NETWORK and sets safe defaults per deployment tier.
case "${ENVIRONMENT}" in
  dev)
    NETWORK="${NETWORK:-testnet}"
    BRIDGE_FEE_BPS="${BRIDGE_FEE_BPS:-30}"
    ;;
  staging)
    NETWORK="${NETWORK:-testnet}"
    BRIDGE_FEE_BPS="${BRIDGE_FEE_BPS:-30}"
    # Staging mirrors production config — validate required secrets are set.
    : "${SOURCE_ACCOUNT:?SOURCE_ACCOUNT required for staging}"
    ;;
  production)
    NETWORK="${NETWORK:-mainnet}"
    BRIDGE_FEE_BPS="${BRIDGE_FEE_BPS:-30}"
    : "${SOURCE_ACCOUNT:?SOURCE_ACCOUNT required for production}"
    : "${SOROBAN_NETWORK_PASSPHRASE:?SOROBAN_NETWORK_PASSPHRASE required for production}"
    ;;
  "")
    # No ENVIRONMENT set — use legacy NETWORK-only mode (backwards-compatible).
    ;;
  *)
    echo "ERROR: unknown ENVIRONMENT '$ENVIRONMENT'. Use dev, staging, or production." >&2
    exit 1
    ;;
esac

# ── network config ───────────────────────────────────────────────────────────
case "$NETWORK" in
  testnet)
    RPC_URL="${SOROBAN_RPC_URL:-https://soroban-rpc.testnet.stellar.org}"
    NETWORK_PASSPHRASE="${SOROBAN_NETWORK_PASSPHRASE:-Test SDF Network ; September 2015}"
    EXPLORER_BASE="https://stellar.expert/explorer/testnet/tx"
    ;;
  mainnet)
    RPC_URL="${SOROBAN_RPC_URL:-https://mainnet.sorobanrpc.com}"
    NETWORK_PASSPHRASE="${SOROBAN_NETWORK_PASSPHRASE:-Public Global Stellar Network ; September 2015}"
    EXPLORER_BASE="https://stellar.expert/explorer/public/tx"
    ;;
  custom)
    RPC_URL="${SOROBAN_RPC_URL:?SOROBAN_RPC_URL required for custom network}"
    NETWORK_PASSPHRASE="${SOROBAN_NETWORK_PASSPHRASE:?SOROBAN_NETWORK_PASSPHRASE required for custom network}"
    EXPLORER_BASE="${EXPLORER_BASE:-}"
    ;;
  *)
    echo "ERROR: unknown network '$NETWORK'. Use testnet, mainnet, or custom." >&2
    exit 1
    ;;
esac

SOURCE_ACCOUNT="${SOURCE_ACCOUNT:?SOURCE_ACCOUNT (Stellar secret key) is required}"
ARTIFACT_FILE="${ARTIFACTS_DIR}/deployment-${ENVIRONMENT:-${NETWORK}}.json"

log()  { echo "[$(date -u +%H:%M:%SZ)] $*"; }
warn() { echo "[$(date -u +%H:%M:%SZ)] WARN: $*" >&2; }
err()  { echo "[$(date -u +%H:%M:%SZ)] ERROR: $*" >&2; exit 1; }

# ── idempotency: check existing deployment ───────────────────────────────────
check_existing() {
  if [[ -f "$ARTIFACT_FILE" ]]; then
    local existing_id
    existing_id=$(jq -r '.contractId // empty' "$ARTIFACT_FILE" 2>/dev/null || true)
    if [[ -n "$existing_id" ]]; then
      log "Found existing deployment for $NETWORK: $existing_id"
      log "Verifying contract is still live..."
      if stellar contract invoke \
          --id "$existing_id" \
          --rpc-url "$RPC_URL" \
          --network-passphrase "$NETWORK_PASSPHRASE" \
          --source "$SOURCE_ACCOUNT" \
          -- version 2>/dev/null; then
        log "Contract $existing_id is already deployed and live. Skipping."
        log "Artifact: $ARTIFACT_FILE"
        exit 0
      else
        warn "Existing contract $existing_id not responding. Re-deploying."
      fi
    fi
  fi
}

# ── step 1: build ─────────────────────────────────────────────────────────────
build_contract() {
  if $SKIP_BUILD; then
    log "Skipping build (--skip-build)"
    return
  fi
  log "Building contract..."
  stellar contract build --manifest-path "$CONTRACT_DIR/Cargo.toml"
  log "Build complete."
}

# ── step 2: deploy ────────────────────────────────────────────────────────────
deploy_contract() {
  local wasm_path
  wasm_path=$(find target/wasm32-unknown-unknown/release -name "onboarding_bridge.wasm" | head -1)
  [[ -z "$wasm_path" ]] && err "WASM not found. Run without --skip-build."

  log "Deploying contract from $wasm_path..."
  local deploy_output
  deploy_output=$(stellar contract deploy \
    --wasm "$wasm_path" \
    --source "$SOURCE_ACCOUNT" \
    --rpc-url "$RPC_URL" \
    --network-passphrase "$NETWORK_PASSPHRASE" 2>&1)

  CONTRACT_ID=$(echo "$deploy_output" | grep -E '^[GC][A-Z2-7]{55}$' | tail -1)
  DEPLOY_TX=$(echo "$deploy_output" | grep -Eo '[a-f0-9]{64}' | tail -1 || true)

  [[ -z "$CONTRACT_ID" ]] && err "Could not extract contract ID from deploy output: $deploy_output"
  log "Contract deployed: $CONTRACT_ID"
}

# ── step 3: initialize ────────────────────────────────────────────────────────
initialize_contract() {
  local fee_bps="${BRIDGE_FEE_BPS:-30}"
  log "Initializing contract with fee_bps=$fee_bps..."
  stellar contract invoke \
    --id "$CONTRACT_ID" \
    --rpc-url "$RPC_URL" \
    --network-passphrase "$NETWORK_PASSPHRASE" \
    --source "$SOURCE_ACCOUNT" \
    -- initialize \
    --admin "$SOURCE_ACCOUNT" \
    --fee_bps "$fee_bps"
  log "Contract initialized."
}

# ── step 4: verify on explorer ────────────────────────────────────────────────
verify_on_explorer() {
  if [[ -z "$EXPLORER_BASE" ]]; then
    log "No explorer configured for this network. Skipping verification link."
    return
  fi
  if [[ -n "${DEPLOY_TX:-}" ]]; then
    log "Explorer: $EXPLORER_BASE/$DEPLOY_TX"
  fi
  log "Contract on explorer: https://stellar.expert/explorer/${NETWORK}/contract/$CONTRACT_ID"
}

# ── step 5: persist artifacts ─────────────────────────────────────────────────
save_artifacts() {
  local artifact_env="${ENVIRONMENT:-${NETWORK}}"
  ARTIFACT_FILE="${ARTIFACTS_DIR}/deployment-${artifact_env}.json"
  mkdir -p "$ARTIFACTS_DIR"
  local ts
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  jq -n \
    --arg environment "${artifact_env}" \
    --arg network "$NETWORK" \
    --arg contractId "$CONTRACT_ID" \
    --arg deployTx "${DEPLOY_TX:-}" \
    --arg rpcUrl "$RPC_URL" \
    --arg deployedAt "$ts" \
    '{environment: $environment, network: $network, contractId: $contractId, deployTx: $deployTx, rpcUrl: $rpcUrl, deployedAt: $deployedAt}' \
    > "$ARTIFACT_FILE"
  log "Artifacts saved to $ARTIFACT_FILE"
}

# ── rollback ──────────────────────────────────────────────────────────────────
rollback() {
  local env="${ENVIRONMENT:-${NETWORK}}"
  local rollback_file="${ARTIFACTS_DIR}/rollback-${env}.sh"

  log "Rolling back $env (steps=$ROLLBACK_STEPS)..."

  # If a rollback script was saved by a previous deploy hook, run it.
  if [[ -f "$rollback_file" ]]; then
    log "Executing rollback script: $rollback_file"
    bash "$rollback_file" "$ROLLBACK_STEPS"
    log "Rollback complete."
    return
  fi

  # Fallback: re-deploy the previous artifact if available.
  local prev_artifact="${ARTIFACTS_DIR}/deployment-${env}.prev.json"
  if [[ -f "$prev_artifact" ]]; then
    log "Re-deploying previous artifact from $prev_artifact"
    local prev_id
    prev_id=$(jq -r '.contractId // empty' "$prev_artifact")
    [[ -z "$prev_id" ]] && err "No contractId in $prev_artifact"
    log "Previous contract ID: $prev_id — update your service to point to this ID."
    # Swap current ↔ prev artifacts so status is accurate
    cp "${ARTIFACTS_DIR}/deployment-${env}.json" "${ARTIFACTS_DIR}/deployment-${env}.rolledback.json" 2>/dev/null || true
    cp "$prev_artifact" "${ARTIFACTS_DIR}/deployment-${env}.json"
    log "Rollback artifact swapped. CONTRACT_ID=$prev_id"
    return
  fi

  err "No rollback script or previous artifact found for '$env'. Manual rollback required."
}

# ── main ──────────────────────────────────────────────────────────────────────
main() {
  local env_label="${ENVIRONMENT:-$NETWORK}"
  log "Starting deployment: environment=${env_label} network=${NETWORK} dry_run=${DRY_RUN} rollback=${ROLLBACK}"

  if $ROLLBACK; then
    rollback
    exit 0
  fi

  if $DRY_RUN; then
    log "DRY RUN — validating environment only"
    build_contract
    log "DRY RUN complete. No contract was deployed."
    exit 0
  fi

  # Preserve current artifact as previous before overwriting
  local artifact_env="${ENVIRONMENT:-${NETWORK}}"
  local current="${ARTIFACTS_DIR}/deployment-${artifact_env}.json"
  if [[ -f "$current" ]]; then
    cp "$current" "${ARTIFACTS_DIR}/deployment-${artifact_env}.prev.json"
  fi

  check_existing
  build_contract
  deploy_contract
  initialize_contract
  verify_on_explorer
  save_artifacts

  log "Deployment complete."
  log "CONTRACT_ID=$CONTRACT_ID"
}

main
