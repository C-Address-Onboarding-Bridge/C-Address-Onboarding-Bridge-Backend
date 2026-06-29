#!/usr/bin/env bash
# Post-deploy smoke tests — fast health and readiness checks.
# Usage: APP_URL=https://api.example.com SMOKE_API_KEY=xxx bash scripts/smoke-test.sh

set -euo pipefail

APP_URL="${APP_URL:?APP_URL is required}"
SMOKE_API_KEY="${SMOKE_API_KEY:-}"
MAX_WAIT="${MAX_WAIT:-60}"   # seconds to wait for the app to become healthy
INTERVAL=5

log()  { echo "[smoke] $*"; }
fail() { echo "[smoke] FAIL: $*" >&2; exit 1; }

# ── 1. Wait for health endpoint ────────────────────────────────────────────
log "Waiting for $APP_URL/health (up to ${MAX_WAIT}s)..."
elapsed=0
until curl -sf "$APP_URL/health" > /dev/null; do
  if (( elapsed >= MAX_WAIT )); then
    fail "/health did not respond within ${MAX_WAIT}s"
  fi
  sleep $INTERVAL
  elapsed=$(( elapsed + INTERVAL ))
done
log "/health OK"

# ── 2. Health response has expected shape ──────────────────────────────────
body=$(curl -sf "$APP_URL/health")
status=$(echo "$body" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4)
[[ "$status" == "ok" ]] || fail "/health returned unexpected status: $body"
log "/health body OK (status=ok)"

# ── 3. Readiness / metrics endpoint ───────────────────────────────────────
curl -sf "$APP_URL/metrics" > /dev/null || fail "/metrics endpoint unreachable"
log "/metrics OK"

# ── 4. API v1 quote endpoint (unauthenticated GET) ─────────────────────────
http_code=$(curl -s -o /dev/null -w "%{http_code}" \
  "$APP_URL/api/v1/quote?sourceAsset=XLM&amount=1000&targetAddress=CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM")
# 200 means the endpoint is up; 400/422 (bad input) is also fine — it means the app is running
[[ "$http_code" =~ ^(200|400|422)$ ]] || fail "/api/v1/quote returned unexpected HTTP $http_code"
log "/api/v1/quote smoke OK (HTTP $http_code)"

# ── 5. API key auth check (if key provided) ────────────────────────────────
if [[ -n "$SMOKE_API_KEY" ]]; then
  auth_code=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "X-API-Key: $SMOKE_API_KEY" \
    "$APP_URL/api/v1/quote?sourceAsset=XLM&amount=1000&targetAddress=CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM")
  [[ "$auth_code" =~ ^(200|400|422)$ ]] || fail "Authenticated request returned HTTP $auth_code"
  log "Auth smoke OK (HTTP $auth_code)"
fi

log "All smoke tests passed ✓"
