# Developer Setup Guide

This guide gets you from a fresh clone to a fully running local environment in one command.

---

## Quick Start

```bash
git clone https://github.com/C-Address-Onboarding-Bridge/C-Address-Onboarding-Bridge-Backend.git
cd C-Address-Onboarding-Bridge-Backend
./scripts/setup-dev.sh
```

The bootstrap script handles everything: dependencies, `.env`, Docker stack, migrations, and build. Jump to [Manual Setup](#manual-setup) if you prefer full control.

---

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Node.js | 20+ | https://nodejs.org |
| npm | 9+ | Bundled with Node |
| Docker + Compose v2 | latest | https://docs.docker.com/get-docker/ |
| Rust + `cargo` | 1.96+ | https://rustup.rs *(contract dev only)* |

Verify:

```bash
node --version   # v20+
docker compose version  # v2+
```

---

## Docker Compose Stack

The stack is split across two files:

- `docker-compose.yml` — production-shaped services with pinned images
- `docker-compose.override.yml` — dev overrides (source mounts, hot reload, debug port) applied automatically

### Services

| Service | Local port | Description |
|---------|-----------|-------------|
| `api` | 3001 | Express API with `tsx watch` hot reload |
| `postgres` | 5432 | PostgreSQL 16 |
| `redis` | 6379 | Redis 7 |
| `soroban-quickstart` | 8000 | Stellar local sandbox + Soroban RPC |

### Start / Stop

```bash
# Full stack (recommended)
docker compose up

# Detached + follow API logs only
docker compose up -d && docker compose logs -f api

# Stop and remove containers (keeps volumes)
docker compose down

# Stop and wipe volumes (full reset)
docker compose down -v
```

### Accessing services from host

```
API:             http://localhost:3001
API health:      http://localhost:3001/health
Soroban RPC:     http://localhost:8000/soroban/rpc
Friendbot:       http://localhost:8000/friendbot?addr=<G-address>
Postgres:        postgresql://bridge:bridge@localhost:5432/bridge
Redis:           redis://localhost:6379
```

---

## Manual Setup

Use this if the bootstrap script doesn't fit your workflow.

### 1. Environment variables

```bash
cp .env.local.example .env
# Edit .env — BRIDGE_CONTRACT_ID is required to run funded transactions
```

### 2. Install dependencies

```bash
npm install
```

### 3. Start backing services

```bash
docker compose up -d postgres redis soroban-quickstart
```

### 4. Run migrations

```bash
npm run migrate -w api
```

### 5. Start the API in dev mode

```bash
npm run dev -w api
```

### 6. (Optional) Deploy the Soroban contract locally

```bash
cd contracts/onboarding-bridge

# Build WASM
cargo build --target wasm32-unknown-unknown --release

# Deploy to local sandbox
soroban contract deploy \
  --wasm target/wasm32-unknown-unknown/release/onboarding_bridge.wasm \
  --source <admin-secret> \
  --rpc-url http://localhost:8000/soroban/rpc \
  --network-passphrase "Standalone Network ; February 2017"

# Initialize (paste the contract ID returned above)
soroban contract invoke \
  --id <contract-id> \
  --source <admin-secret> \
  --rpc-url http://localhost:8000/soroban/rpc \
  --network-passphrase "Standalone Network ; February 2017" \
  -- initialize --admin <admin-address> --fee_bps 30
```

Paste the deployed contract ID into `.env` as `BRIDGE_CONTRACT_ID`.

---

## Environment Variables

All variables are documented in `.env.local.example`. Key ones for local dev:

| Variable | Default (local) | Notes |
|----------|----------------|-------|
| `DATABASE_URL` | `postgres://bridge:bridge@localhost:5432/bridge` | Set automatically by Docker |
| `REDIS_URL` | `redis://localhost:6379` | Set automatically by Docker |
| `SOROBAN_RPC_URL` | `http://localhost:8000/soroban/rpc` | Local quickstart sandbox |
| `SOROBAN_NETWORK_PASSPHRASE` | `Standalone Network ; February 2017` | Local sandbox passphrase |
| `BRIDGE_CONTRACT_ID` | *(empty)* | Fill after local contract deploy |
| `API_KEYS` | `dev-api-key` | Add `X-API-Key: dev-api-key` header |
| `LOG_LEVEL` | `debug` | `trace \| debug \| info \| warn \| error` |
| `IDEMPOTENCY_KEY_REQUIRED` | `false` | Set `true` to test idempotency keys |

When running via `docker compose up`, the API container reads from the `environment:` block in `docker-compose.yml`. When running `npm run dev -w api` directly on your host, it reads from `.env`.

---

## Database Migrations

```bash
# Apply pending migrations
npm run migrate -w api

# Check migration status
npm run migrate:status -w api

# Roll back last migration
npm run migrate:rollback -w api

# Seed dev data
npm run migrate:seed -w api
```

---

## Running Tests

```bash
# All workspaces
npm test

# API unit tests only
npm test -w api

# API E2E tests (requires Docker stack running)
npm run test:e2e -w api

# SDK tests
npm test -w sdk

# Rust contract tests
cd contracts/onboarding-bridge && cargo test
```

---

## VS Code

Install recommended extensions when prompted, or manually:

```
Ctrl+Shift+P → Extensions: Show Recommended Extensions
```

Key extensions: ESLint, Prettier, rust-analyzer, Docker, YAML, Even Better TOML.

The workspace settings in `.vscode/settings.json` configure:
- Format-on-save with Prettier
- ESLint auto-fix on save
- Workspace TypeScript SDK
- rust-analyzer with all Cargo features enabled
- Search/file exclusions for `node_modules`, `dist`, `target`

---

## Git Hooks

[husky](https://typicode.github.io/husky/) runs [lint-staged](https://github.com/lint-staged/lint-staged) on every `git commit`. Only staged TypeScript files in `api/src` and `sdk/src` are linted and auto-fixed — unstaged files are never touched.

Hooks are installed automatically by `npm install` via the `prepare` script. If they're not running:

```bash
npx husky
```

To bypass in an emergency (avoid habitually):

```bash
git commit --no-verify -m "your message"
```

---

## Debugging

The dev override exposes Node.js inspector on port `9229`. In VS Code, add a launch config:

```jsonc
// .vscode/launch.json
{
  "configurations": [
    {
      "name": "Attach to Docker API",
      "type": "node",
      "request": "attach",
      "port": 9229,
      "remoteRoot": "/app"
    }
  ]
}
```

Then start with `--inspect`:

```bash
# docker-compose.override.yml already adds -w api, so just:
docker compose up api
```

---

## Troubleshooting

### `docker compose up` fails to start soroban-quickstart

The quickstart image can take 30–60 seconds on first pull. Wait for the health check to pass:

```bash
docker compose ps  # wait until soroban-quickstart is "healthy"
```

If it stays unhealthy:

```bash
docker compose logs soroban-quickstart
# Common fix: pull a fresh image
docker pull stellar/quickstart:latest && docker compose up -d soroban-quickstart
```

### Postgres "role bridge does not exist"

The volume was created with a different user. Wipe and recreate:

```bash
docker compose down -v
docker compose up -d postgres
npm run migrate -w api
```

### `ECONNREFUSED` when starting API locally (without Docker)

The API can't reach Postgres or Redis. Either:
- Start the Docker services: `docker compose up -d postgres redis`
- Or verify `DATABASE_URL` and `REDIS_URL` in `.env` point to running instances

### Port already in use

```bash
# Find the process using port 3001
lsof -i :3001   # macOS/Linux
# Change PORT in .env to an available port
```

### `BRIDGE_CONTRACT_ID` not set — funded transactions fail

The API will start but `/api/v1/fund` calls will fail. Deploy the contract locally (see [Manual Setup](#manual-setup) step 6) and set the ID in `.env`.

### ESLint not running on save in VS Code

1. Check `dbaeumer.vscode-eslint` is installed and enabled
2. Run `npm install` to ensure `eslint` and `@typescript-eslint/parser` are present
3. Check the ESLint output panel (`View → Output → ESLint`) for errors

### Husky hooks not firing

```bash
# Reinstall hooks
npx husky

# Verify the hook file is executable
ls -la .husky/pre-commit
chmod +x .husky/pre-commit
```

### `cargo build` fails — wasm target missing

```bash
rustup target add wasm32-unknown-unknown
```

---

## Useful Commands Reference

```bash
# Start everything
docker compose up

# Restart just the API (picks up code changes outside hot-reload)
docker compose restart api

# Open a psql shell
docker compose exec postgres psql -U bridge bridge

# Redis CLI
docker compose exec redis redis-cli

# Fund a local G-address via friendbot
curl "http://localhost:8000/friendbot?addr=<your-G-address>"

# Watch API logs
docker compose logs -f api

# Run linter across all workspaces
npm run lint

# Full clean (removes dist, keeps node_modules)
npm run build
```
