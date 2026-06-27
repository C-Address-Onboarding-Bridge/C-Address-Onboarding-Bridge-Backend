#!/usr/bin/env bash
set -euo pipefail

BOLD="\033[1m"
GREEN="\033[32m"
YELLOW="\033[33m"
RED="\033[31m"
RESET="\033[0m"

info()  { echo -e "${BOLD}${GREEN}[setup]${RESET} $*"; }
warn()  { echo -e "${BOLD}${YELLOW}[warn] ${RESET} $*"; }
fatal() { echo -e "${BOLD}${RED}[error]${RESET} $*" >&2; exit 1; }

check_cmd() { command -v "$1" &>/dev/null || fatal "$1 is required but not found. $2"; }

# ── Prerequisites ─────────────────────────────────────────────────────────────
info "Checking prerequisites..."
check_cmd node  "Install from https://nodejs.org (v20+)"
check_cmd npm   "Comes with Node.js"
check_cmd docker "Install from https://docs.docker.com/get-docker/"
check_cmd docker "Need Docker with Compose v2"

NODE_VERSION=$(node -e "process.stdout.write(process.version.replace('v',''))")
MAJOR="${NODE_VERSION%%.*}"
[[ "$MAJOR" -ge 20 ]] || fatal "Node.js 20+ required, found v${NODE_VERSION}"

# Optional: Rust for contract development
if command -v cargo &>/dev/null; then
  info "Rust detected — contract development available"
else
  warn "Rust not found. Install via https://rustup.rs if you need to build Soroban contracts."
fi

# ── Environment file ──────────────────────────────────────────────────────────
if [[ ! -f .env ]]; then
  info "Creating .env from .env.local.example..."
  cp .env.local.example .env
  warn "Review .env and fill in BRIDGE_CONTRACT_ID before running the API."
else
  info ".env already exists — skipping copy"
fi

# ── Node dependencies ─────────────────────────────────────────────────────────
info "Installing Node.js dependencies..."
npm install

# ── Git hooks ─────────────────────────────────────────────────────────────────
info "Installing git hooks (husky)..."
npx husky || warn "Husky setup failed — git hooks won't run. Re-run 'npx husky' manually."

# ── Docker stack ──────────────────────────────────────────────────────────────
info "Starting Docker Compose stack (postgres, redis, soroban-quickstart)..."
docker compose up -d postgres redis soroban-quickstart

info "Waiting for Postgres to be healthy..."
for i in $(seq 1 30); do
  docker compose exec -T postgres pg_isready -U bridge &>/dev/null && break
  sleep 2
  [[ "$i" -eq 30 ]] && fatal "Postgres never became healthy"
done

# ── Database migrations ───────────────────────────────────────────────────────
info "Running database migrations..."
DATABASE_URL="${DATABASE_URL:-postgres://bridge:bridge@localhost:5432/bridge}"
export DATABASE_URL
npm run migrate -w api || warn "Migrations failed — check DATABASE_URL in .env"

# ── Build ─────────────────────────────────────────────────────────────────────
info "Building TypeScript packages..."
npm run build

echo ""
echo -e "${BOLD}${GREEN}✓ Dev environment ready!${RESET}"
echo ""
echo "  Start the full stack:    docker compose up"
echo "  Start API only (hot):    npm run dev -w api"
echo "  Run tests:               npm test"
echo "  Soroban RPC:             http://localhost:8000/soroban/rpc"
echo "  Friendbot (fund accts):  http://localhost:8000/friendbot?addr=<G-address>"
echo "  API:                     http://localhost:${PORT:-3001}"
echo "  API health:              http://localhost:${PORT:-3001}/health"
echo ""
