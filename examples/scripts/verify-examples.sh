#!/usr/bin/env bash
# verify-examples.sh — Run each language's integration smoke test against the
# mock server, then run each language's unit tests.  Fails loudly on any error.
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

# Wait for the mock to be healthy; fail if it never starts.
ready=0
for _ in $(seq 1 30); do
  if curl -sf "http://localhost:${MOCK_PORT}/health" >/dev/null; then
    ready=1
    break
  fi
  sleep 0.2
done

if [[ $ready -eq 0 ]]; then
  echo "ERROR: mock server did not become healthy after 6 s" >&2
  exit 1
fi

# ── Integration smoke tests ──────────────────────────────────────────────────

echo "==> Python (integration)"
(cd "$ROOT/python" && python3 main.py)

echo "==> Rust (integration)"
(cd "$ROOT/rust" && cargo run --example bridge --quiet)

echo "==> Go (integration)"
(cd "$ROOT/go" && go run .)

echo "==> Java (integration)"
(cd "$ROOT/java" && mvn -q exec:java)

# ── Unit tests ───────────────────────────────────────────────────────────────

echo "==> Python (unit tests)"
(cd "$ROOT/python" && python3 -m unittest discover -s tests)

echo "==> Rust (unit tests)"
(cd "$ROOT/rust" && cargo test --quiet)

echo "==> Go (unit tests)"
(cd "$ROOT/go" && go test ./...)

echo "==> Java (unit tests)"
(cd "$ROOT/java" && mvn -q test)

echo "All multi-language examples and unit tests passed."
