#!/usr/bin/env bash
# Contract deployment automation script for C-Address Onboarding Bridge
# Usage: ./scripts/deploy.sh [--network testnet|mainnet|custom] [--dry-run] [--skip-build]

set -euo pipefail

# ── defaults ─────────────────────────────────────────────────────────────────
NETWORK="${NETWORK:-testnet}"
DRY_RUN=false
SKIP_BUILD=false
ARTIFACTS_DIR="deployments"
ARTIFACT_FILE=""
CONTRACT_DIR="contracts/onboarding-bridge"

# ── parse args ───────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --network)   NETWORK="$2";   shift 2 ;;
    --dry-run)   DRY_RUN=true;   shift   ;;
    --skip-build) SKIP_BUILD=true; shift ;;
    *) echo "Unknown flag: $1"; exit 1 ;;
  esac
done

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
ARTIFACT_FILE="${ARTIFACTS_DIR}/deployment-${NETWORK}.json"

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
  mkdir -p "$ARTIFACTS_DIR"
  local ts
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  jq -n \
    --arg network "$NETWORK" \
    --arg contractId "$CONTRACT_ID" \
    --arg deployTx "${DEPLOY_TX:-}" \
    --arg rpcUrl "$RPC_URL" \
    --arg deployedAt "$ts" \
    '{network: $network, contractId: $contractId, deployTx: $deployTx, rpcUrl: $rpcUrl, deployedAt: $deployedAt}' \
    > "$ARTIFACT_FILE"
  log "Artifacts saved to $ARTIFACT_FILE"
}

# ── main ──────────────────────────────────────────────────────────────────────
main() {
  log "Starting deployment to $NETWORK (dry_run=$DRY_RUN)"

  if $DRY_RUN; then
    log "DRY RUN — validating environment only"
    build_contract
    log "DRY RUN complete. No contract was deployed."
    exit 0
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
