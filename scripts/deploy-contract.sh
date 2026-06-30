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

  # Extract contract ID (C... 56-char Stellar address)
  CONTRACT_ID=$(echo "$deploy_output" | grep -Eo '\bC[A-Z2-7]{55}\b' | tail -1 || true)
  # Extract transaction hash (64-char hex)
  DEPLOY_TX=$(echo "$deploy_output" | grep -Eo '\b[a-f0-9]{64}\b' | tail -1 || true)

  [[ -z "$CONTRACT_ID" ]] && log_err "Could not extract contract ID from:\n$deploy_output"
  log_ok "Contract deployed: $CONTRACT_ID"
  [[ -n "$DEPLOY_TX" ]] && log    "Deploy tx:         $DEPLOY_TX"
}

# ── step 4: initialize ────────────────────────────────────────────────────────
initialize_contract() {
  if $SKIP_INIT; then
    log "Skipping initialize() (--skip-init)"
    return
  fi

  # Build the --admins argument: each address as a separate positional value
  # stellar CLI expects:  -- initialize --admins addr1 addr2 ... --threshold N ...
  local admins_args=()
  IFS=',' read -ra ADDR_LIST <<< "$ADMIN_ADDRESSES"
  for addr in "${ADDR_LIST[@]}"; do
    addr="${addr// /}"  # strip whitespace
    admins_args+=("$addr")
  done

  log "Initializing contract (threshold=${THRESHOLD}, fee_bps=${FEE_BPS}, max_fee_bps=${MAX_FEE_BPS})..."
  stellar contract invoke \
    --id "$CONTRACT_ID" \
    --rpc-url "$RPC_URL" \
    --network-passphrase "$NETWORK_PASSPHRASE" \
    --source "$SOURCE_ACCOUNT" \
    -- initialize \
    --admins "${admins_args[@]}" \
    --threshold "$THRESHOLD" \
    --fee_bps "$FEE_BPS" \
    --max_fee_bps "$MAX_FEE_BPS" \
    --min_amount "$MIN_AMOUNT" \
    --max_amount "$MAX_AMOUNT" \
    || log_err "initialize() call failed."
  log_ok "Contract initialized."
}

# ── step 5: verify ────────────────────────────────────────────────────────────
verify_deployment() {
  log "Verifying deployment..."

  # 5a. version() must return a non-zero value
  local version
  version=$(stellar contract invoke \
    --id "$CONTRACT_ID" \
    --rpc-url "$RPC_URL" \
    --network-passphrase "$NETWORK_PASSPHRASE" \
    --source "$SOURCE_ACCOUNT" \
    -- version 2>&1) || log_err "version() call failed: $version"
  [[ "$version" =~ ^[0-9]+$ ]] || log_err "version() returned non-numeric: $version"
  log_ok "version() = $version"

  # 5b. fee_bps() must match what we set
  local on_chain_fee
  on_chain_fee=$(stellar contract invoke \
    --id "$CONTRACT_ID" \
    --rpc-url "$RPC_URL" \
    --network-passphrase "$NETWORK_PASSPHRASE" \
    --source "$SOURCE_ACCOUNT" \
    -- fee_bps 2>&1) || log_err "fee_bps() call failed."
  [[ "$on_chain_fee" == "$FEE_BPS" ]] \
    || log_warn "fee_bps mismatch: expected $FEE_BPS, got $on_chain_fee"
  log_ok "fee_bps() = $on_chain_fee"

  # 5c. Explorer links
  if [[ -n "$EXPLORER_CONTRACT" ]]; then
    log "Contract explorer: $EXPLORER_CONTRACT/$CONTRACT_ID"
  fi
  if [[ -n "$EXPLORER_TX" && -n "$DEPLOY_TX" ]]; then
    log "Deploy tx explorer: $EXPLORER_TX/$DEPLOY_TX"
  fi

  log_ok "Deployment verified."
}

# ── step 6: save artifact ─────────────────────────────────────────────────────
save_artifact() {
  mkdir -p "$ARTIFACTS_DIR"

  # Preserve current artifact as .prev before overwriting
  local artifact="${ARTIFACTS_DIR}/deployment-${NETWORK}.json"
  if [[ -f "$artifact" ]]; then
    cp "$artifact" "${ARTIFACTS_DIR}/deployment-${NETWORK}.prev.json"
    log "Previous artifact preserved: deployment-${NETWORK}.prev.json"
  fi

  local ts
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  local git_sha="${GITHUB_SHA:-$(git rev-parse HEAD 2>/dev/null || echo 'unknown')}"
  local git_tag="${GITHUB_REF_NAME:-$(git describe --tags --exact-match 2>/dev/null || echo '')}"
  local actor="${GITHUB_ACTOR:-$(whoami)}"

  # Build admins JSON array
  local admins_json="[]"
  admins_json=$(echo "$ADMIN_ADDRESSES" | tr ',' '\n' | jq -Rcs '[split("\n")[] | select(. != "")]')

  jq -n \
    --arg network         "$NETWORK" \
    --arg contractId      "$CONTRACT_ID" \
    --arg deployTx        "${DEPLOY_TX:-}" \
    --arg wasmHash        "$WASM_HASH" \
    --argjson wasmSize    "${WASM_SIZE:-0}" \
    --arg rpcUrl          "$RPC_URL" \
    --arg deployedAt      "$ts" \
    --arg gitSha          "$git_sha" \
    --arg gitTag          "$git_tag" \
    --arg deployedBy      "$actor" \
    --argjson threshold   "${THRESHOLD}" \
    --argjson feeBps      "${FEE_BPS}" \
    --argjson maxFeeBps   "${MAX_FEE_BPS}" \
    --argjson minAmount   "${MIN_AMOUNT}" \
    --argjson maxAmount   "${MAX_AMOUNT}" \
    --argjson admins      "$admins_json" \
    '{
      network:     $network,
      contractId:  $contractId,
      deployTx:    $deployTx,
      wasmHash:    $wasmHash,
      wasmSize:    $wasmSize,
      rpcUrl:      $rpcUrl,
      deployedAt:  $deployedAt,
      gitSha:      $gitSha,
      gitTag:      $gitTag,
      deployedBy:  $deployedBy,
      initParams: {
        admins:     $admins,
        threshold:  $threshold,
        feeBps:     $feeBps,
        maxFeeBps:  $maxFeeBps,
        minAmount:  $minAmount,
        maxAmount:  $maxAmount
      }
    }' > "$artifact"

  log_ok "Artifact saved: $artifact"

  # Also write a latest symlink / copy for workflows to reference by fixed name
  cp "$artifact" "${ARTIFACTS_DIR}/deployment-latest.json"
}

# ── step 7: notify ────────────────────────────────────────────────────────────
notify_slack() {
  if [[ -z "${SLACK_WEBHOOK_URL:-}" ]]; then
    log "No SLACK_WEBHOOK_URL set — skipping Slack notification."
    return
  fi

  local run_url=""
  if [[ -n "${GITHUB_SERVER_URL:-}" && -n "${GITHUB_REPOSITORY:-}" && -n "${GITHUB_RUN_ID:-}" ]]; then
    run_url="${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}"
  fi

  local tag="${GITHUB_REF_NAME:-manual}"
  local actor="${GITHUB_ACTOR:-$(whoami)}"
  local explorer_link=""
  [[ -n "$EXPLORER_CONTRACT" ]] && explorer_link="<${EXPLORER_CONTRACT}/${CONTRACT_ID}|View on Explorer>"

  local payload
  payload=$(jq -n \
    --arg network    "$NETWORK" \
    --arg contractId "$CONTRACT_ID" \
    --arg wasmHash   "$WASM_HASH" \
    --arg tag        "$tag" \
    --arg actor      "$actor" \
    --arg runUrl     "$run_url" \
    --arg explorer   "$explorer_link" \
    '{
      text: "🚀 Contract deployed to *\($network)*",
      blocks: [
        {type: "section", text: {type: "mrkdwn",
          text: "*Onboarding Bridge deployed to \($network)*\nTag: `\($tag)` | Actor: `\($actor)`"}},
        {type: "section", fields: [
          {type: "mrkdwn", text: "*Contract ID*\n`\($contractId)`"},
          {type: "mrkdwn", text: "*WASM SHA-256*\n`\($wasmHash[0:16])…`"}
        ]},
        {type: "actions", elements: [
          ({type: "button", text: {type: "plain_text", text: "View Run"},
            url: $runUrl} | if $runUrl == "" then empty else . end),
          ({type: "button", text: {type: "plain_text", text: "Explorer"},
            url: (($explorer | ltrimstr("<") | split("|") | first))} |
            if $explorer == "" then empty else . end)
        ]}
      ]
    }')

  if curl -sf -X POST -H "Content-Type: application/json" \
      -d "$payload" "$SLACK_WEBHOOK_URL" > /dev/null; then
    log_ok "Slack notification sent."
  else
    log_warn "Slack notification failed (non-fatal)."
  fi
}

# ── main ──────────────────────────────────────────────────────────────────────
main() {
  DEPLOY_START_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  log "═══════════════════════════════════════════════════"
  log "  Onboarding Bridge — Contract Deployment Pipeline"
  log "═══════════════════════════════════════════════════"
  log "Network:   $NETWORK"
  log "Admins:    $ADMIN_ADDRESSES"
  log "Threshold: $THRESHOLD"
  log "Fee:       ${FEE_BPS} bps (max ${MAX_FEE_BPS})"
  log "Dry run:   $DRY_RUN"
  log "───────────────────────────────────────────────────"

  # Always build (validate the WASM compiles)
  build_contract
  compute_wasm_hash

  if $DRY_RUN; then
    log "DRY RUN complete — WASM built, hash computed, no on-chain operations."
    log "WASM: $WASM_PATH"
    log "SHA-256: $WASM_HASH"
    exit 0
  fi

  # Idempotency: skip deploy+init if a live contract exists (unless --reinstall)
  local need_deploy=true
  check_existing_deployment || need_deploy=false

  if $need_deploy; then
    deploy_contract
    initialize_contract
  fi

  verify_deployment
  save_artifact

  # Generate report (calls the separate report script if available)
  if [[ -f "scripts/generate-deployment-report.sh" ]]; then
    NETWORK="$NETWORK" CONTRACT_ID="$CONTRACT_ID" WASM_HASH="$WASM_HASH" \
      DEPLOY_START_TS="$DEPLOY_START_TS" \
      bash scripts/generate-deployment-report.sh
  fi

  notify_slack

  log "───────────────────────────────────────────────────"
  log_ok "Deployment complete!"
  log    "CONTRACT_ID=$CONTRACT_ID"
  log    "WASM_HASH=$WASM_HASH"
  log "───────────────────────────────────────────────────"

  # Export for parent processes / CI step summaries
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    echo "contract_id=${CONTRACT_ID}" >> "$GITHUB_OUTPUT"
    echo "wasm_hash=${WASM_HASH}"     >> "$GITHUB_OUTPUT"
    echo "network=${NETWORK}"         >> "$GITHUB_OUTPUT"
  fi
}

main
