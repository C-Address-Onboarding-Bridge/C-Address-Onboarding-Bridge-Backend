#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MOCK_PORT="${MOCK_PORT:-3099}"
export BRIDGE_BASE_URL="http://localhost:${MOCK_PORT}"

cleanup() {
  if [[ -n "${MOCK_PID:-}" ]]; then
    kill "$MOCK_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

node "$ROOT/mock-server/server.mjs" &
MOCK_PID=$!

for _ in $(seq 1 30); do
  if curl -sf "http://localhost:${MOCK_PORT}/health" >/dev/null; then
    break
  fi
  sleep 0.2
done

echo "==> Python"
(cd "$ROOT/python" && python3 main.py)

echo "==> Rust"
(cd "$ROOT/rust" && cargo run --example bridge --quiet)

echo "==> Go"
(cd "$ROOT/go" && go run .)

echo "==> Java"
(cd "$ROOT/java" && mvn -q exec:java)

echo "All multi-language examples passed."
