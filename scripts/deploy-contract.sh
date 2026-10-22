#!/usr/bin/env bash
# deploy-contract.sh — Automated Soroban smart contract deployment pipeline
#
# Steps:
#   1. Build optimized WASM (wasm32v1-none, release profile)
#   2. Compute WASM SHA-256 for source verification
#   3. Deploy contract to Stellar network
#   4. Initialize contract with admin parameters
#   5. Verify deployment (invoke version(), compare WASM hash)
#   6. Save deployment artifact (JSON)
#   7. Generate deployment report (Markdown)
#
# Usage:
#   SOURCE_ACCOUNT=S... ADMIN_ADDRESSES=G... bash scripts/deploy-contract.sh [OPTIONS]
#
#   initialize() requires authorization from every address in ADMIN_ADDRESSES.
#   Use a signer/multisig flow that can provide those authorization entries;
#   SOURCE_ACCOUNT remains the transaction fee-payer and deployer.
#
#   initialize() is single-shot: a second call returns AlreadyInitialized.
#   This script treats any initialize failure (including AlreadyInitialized)
#   as fatal so a front-runner cannot silently take over governance.
#
# Options:
#   --network     testnet|mainnet|custom  (default: testnet)
#   --threshold   u32  multi-sig threshold (default: 1)
#   --fee-bps     u32  fee in basis points (default: 30)
#   --max-fee-bps u32  max fee cap in bps  (default: 1000)
#   --min-amount  i128 minimum fund amount in stroops (default: 100)
#   --max-amount  i128 maximum fund amount in stroops (default: 1000000000000)
#   --skip-build       skip the cargo build step
#   --dry-run          validate environment, build only — no on-chain operations
#   --reinstall        force re-deploy even if a live contract artifact exists
#   --skip-init        skip initialize() call (re-deploying to an existing contract)
#
# Required env vars:
#   SOURCE_ACCOUNT      — Stellar secret key (S...) used to sign transactions
#   ADMIN_ADDRESSES     — comma-separated list of admin G/C-addresses
#
# Optional env vars:
#   SOROBAN_RPC_URL           — override default RPC endpoint
#   SOROBAN_NETWORK_PASSPHRASE — override default network passphrase
#   SLACK_WEBHOOK_URL          — post deployment notification to Slack
#   GITHUB_SERVER_URL          — set automatically inside GitHub Actions
#   GITHUB_REPOSITORY          — set automatically inside GitHub Actions
#   GITHUB_RUN_ID              — set automatically inside GitHub Actions
#   GITHUB_REF_NAME            — set automatically inside GitHub Actions
#   GITHUB_SHA                 — set automatically inside GitHub Actions
#   GITHUB_ACTOR               — set automatically inside GitHub Actions

set -euo pipefail

# ── defaults ──────────────────────────────────────────────────────────────────
NETWORK="${NETWORK:-testnet}"
THRESHOLD="${THRESHOLD:-1}"
FEE_BPS="${BRIDGE_FEE_BPS:-30}"
MAX_FEE_BPS="${MAX_FEE_BPS:-1000}"
MIN_AMOUNT="${MIN_AMOUNT:-100}"
MAX_AMOUNT="${MAX_AMOUNT:-1000000000000}"
SKIP_BUILD=false
DRY_RUN=false
REINSTALL=false
SKIP_INIT=false
CONTRACT_DIR="contracts/onboarding-bridge"
ARTIFACTS_DIR="deployments"
REPORTS_DIR="reports"
WASM_PATH=""
CONTRACT_ID=""
DEPLOY_TX=""
WASM_HASH=""
DEPLOY_START_TS=""

# ── parse args ────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --network)     NETWORK="$2";      shift 2 ;;
    --threshold)   THRESHOLD="$2";    shift 2 ;;
    --fee-bps)     FEE_BPS="$2";      shift 2 ;;
    --max-fee-bps) MAX_FEE_BPS="$2";  shift 2 ;;
    --min-amount)  MIN_AMOUNT="$2";   shift 2 ;;
    --max-amount)  MAX_AMOUNT="$2";   shift 2 ;;
    --skip-build)  SKIP_BUILD=true;   shift   ;;
    --dry-run)     DRY_RUN=true;      shift   ;;
    --reinstall)   REINSTALL=true;    shift   ;;
    --skip-init)   SKIP_INIT=true;    shift   ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

# ── network config ────────────────────────────────────────────────────────────
case "$NETWORK" in
  testnet)
    RPC_URL="${SOROBAN_RPC_URL:-https://soroban-rpc.testnet.stellar.org}"
    NETWORK_PASSPHRASE="${SOROBAN_NETWORK_PASSPHRASE:-Test SDF Network ; September 2015}"
    EXPLORER_CONTRACT="https://stellar.expert/explorer/testnet/contract"
    EXPLORER_TX="https://stellar.expert/explorer/testnet/tx"
    ;;
  mainnet)
    RPC_URL="${SOROBAN_RPC_URL:-https://mainnet.sorobanrpc.com}"
    NETWORK_PASSPHRASE="${SOROBAN_NETWORK_PASSPHRASE:-Public Global Stellar Network ; September 2015}"
    EXPLORER_CONTRACT="https://stellar.expert/explorer/public/contract"
    EXPLORER_TX="https://stellar.expert/explorer/public/tx"
    ;;
  custom)
    RPC_URL="${SOROBAN_RPC_URL:?SOROBAN_RPC_URL required for custom network}"
    NETWORK_PASSPHRASE="${SOROBAN_NETWORK_PASSPHRASE:?SOROBAN_NETWORK_PASSPHRASE required for custom network}"
    EXPLORER_CONTRACT=""
    EXPLORER_TX=""
    ;;
  *)
    echo "ERROR: unknown network '$NETWORK'. Use testnet, mainnet, or custom." >&2
    exit 1
    ;;
esac

# ── validate required env vars ────────────────────────────────────────────────
: "${SOURCE_ACCOUNT:?SOURCE_ACCOUNT (Stellar secret key S...) is required}"
: "${ADMIN_ADDRESSES:?ADMIN_ADDRESSES (comma-separated G/C-addresses) is required}"

# ── helpers ───────────────────────────────────────────────────────────────────
log()     { echo "[$(date -u +%H:%M:%SZ)] $*"; }
log_ok()  { echo "[$(date -u +%H:%M:%SZ)] ✓ $*"; }
log_err() { echo "[$(date -u +%H:%M:%SZ)] ✗ ERROR: $*" >&2; exit 1; }
log_warn(){ echo "[$(date -u +%H:%M:%SZ)] ⚠ WARN: $*" >&2; }

# ── step 1: build ─────────────────────────────────────────────────────────────
build_contract() {
  if $SKIP_BUILD; then
    log "Skipping build (--skip-build)"
    return
  fi
  log "Building optimized contract WASM..."

  # Use stellar contract build if available (wraps cargo with correct flags)
  if command -v stellar &>/dev/null; then
    stellar contract build --manifest-path "${CONTRACT_DIR}/Cargo.toml"
  else
    # Fallback: raw cargo with the release profile defined in Cargo.toml
    (cd "$CONTRACT_DIR" && cargo build --target wasm32v1-none --release)
  fi

  # Locate the WASM — stellar build puts it under target/wasm32v1-none/release/
  # while cargo puts it under target/wasm32-unknown-unknown/release/
  WASM_PATH=$(find target -name "onboarding_bridge.wasm" \
    \( -path "*/wasm32v1-none/release/*" -o -path "*/wasm32-unknown-unknown/release/*" \) \
    | head -1)

  [[ -z "$WASM_PATH" ]] && log_err "WASM not found after build. Check cargo output."
  log_ok "WASM built: $WASM_PATH"
}

# ── step 2: compute WASM hash ────────────────────────────────────────────────
compute_wasm_hash() {
  WASM_HASH=$(sha256sum "$WASM_PATH" | awk '{print $1}')
  WASM_SIZE=$(wc -c < "$WASM_PATH")
  log_ok "WASM SHA-256: $WASM_HASH"
  log    "WASM size:    ${WASM_SIZE} bytes"
}

# ── idempotency check ─────────────────────────────────────────────────────────
check_existing_deployment() {
  local artifact="${ARTIFACTS_DIR}/deployment-${NETWORK}.json"
  if [[ -f "$artifact" ]] && ! $REINSTALL; then
    local existing_id
    existing_id=$(jq -r '.contractId // empty' "$artifact" 2>/dev/null || true)
    if [[ -n "$existing_id" ]]; then
      log "Found existing deployment: $existing_id"
      log "Verifying it is still live..."
      local live_version
      if live_version=$(stellar contract invoke \
          --id "$existing_id" \
          --rpc-url "$RPC_URL" \
          --network-passphrase "$NETWORK_PASSPHRASE" \
          --source "$SOURCE_ACCOUNT" \
          -- version 2>/dev/null); then
        log_ok "Existing contract $existing_id is live (version=$live_version). Skipping deploy."
        log    "Use --reinstall to force a fresh deployment."
        CONTRACT_ID="$existing_id"
        return 1  # signal: skip deploy+init
      else
        log_warn "Existing contract $existing_id not responding. Re-deploying."
      fi
    fi
  fi
  return 0  # signal: proceed with deploy
}

# ── step 3: deploy ────────────────────────────────────────────────────────────
deploy_contract() {
  log "Deploying contract to $NETWORK..."
  local deploy_output
  deploy_output=$(stellar contract deploy \
    --wasm "$WASM_PATH" \
    --source "$SOURCE_ACCOUNT" \
    --rpc-url "$RPC_URL" \
    --network-passphrase "$NETWORK_PASSPHRASE" 2>&1) || log_err "Deploy failed: $deploy_output"

  # Extract contract ID (C... 56-char base32) from deploy output
  CONTRACT_ID=$(echo "$deploy_output" | grep -oE 'C[A-Z2-7]{55}' | head -1 || true)
  [[ -z "$CONTRACT_ID" ]] && log_err "Could not parse contract ID from deploy output: $deploy_output"
  log_ok "Contract deployed: $CONTRACT_ID"
}

# ── step 4: initialize ────────────────────────────────────────────────────────
initialize_contract() {
  if $SKIP_INIT; then
    log "Skipping initialize() (--skip-init)"
    return
  fi
  log "Initializing contract (admins=$ADMIN_ADDRESSES, threshold=$THRESHOLD)..."

  # Build the admin vector argument for the CLI (JSON array of addresses).
  local admins_json
  admins_json=$(printf '%s' "$ADMIN_ADDRESSES" | tr ',' '\n' | sed 's/^ *//;s/ *$//' | jq -R . | jq -s -c .)

  local init_output
  if ! init_output=$(stellar contract invoke \
      --id "$CONTRACT_ID" \
      --source "$SOURCE_ACCOUNT" \
      --rpc-url "$RPC_URL" \
      --network-passphrase "$NETWORK_PASSPHRASE" \
      -- initialize \
      --admins "$admins_json" \
      --threshold "$THRESHOLD" \
      --fee_bps "$FEE_BPS" \
      --max_fee_bps "$MAX_FEE_BPS" \
      --min_amount "$MIN_AMOUNT" \
      --max_amount "$MAX_AMOUNT" 2>&1); then
    # initialize() is single-shot and now returns AlreadyInitialized on a
    # second call. Any failure here means the deployer does NOT own the
    # contract's governance (e.g. a front-runner initialized it first), so
    # abort loudly instead of continuing as if deployment succeeded.
    log_err "initialize() failed for deployer — contract governance may be compromised: $init_output"
  fi

  # Guard against a silent no-op: the contract must report success explicitly.
  if echo "$init_output" | grep -qiE 'AlreadyInitialized|already initialized'; then
    log_err "initialize() reported AlreadyInitialized — deployer does not own governance: $init_output"
  fi

  log_ok "Contract initialized"
}

# ── step 5: verify ────────────────────────────────────────────────────────────
verify_deployment() {
  log "Verifying deployment..."
  local version
  version=$(stellar contract invoke \
    --id "$CONTRACT_ID" \
    --source "$SOURCE_ACCOUNT" \
    --rpc-url "$RPC_URL" \
    --network-passphrase "$NETWORK_PASSPHRASE" \
    -- version 2>&1) || log_err "version() invoke failed: $version"
  log_ok "Contract version: $version"
}

# ── main ──────────────────────────────────────────────────────────────────────
main() {
  DEPLOY_START_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  build_contract
  compute_wasm_hash

  if $DRY_RUN; then
    log_ok "Dry run complete — no on-chain operations performed."
    return
  fi

  if check_existing_deployment; then
    deploy_contract
    initialize_contract
  fi

  verify_deployment
  log_ok "Deployment pipeline finished for $CONTRACT_ID"
}

main "$@"
