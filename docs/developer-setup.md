# Developer Setup Guide

This guide standardizes local development for the C-Address Onboarding Bridge backend, SDK, provider integrations, and Soroban contract work. It includes the current npm workflow plus a recommended Docker Compose layout for contributors who want Postgres, Redis, and a local Soroban sandbox in one environment.

## Prerequisites

Install these tools before starting:

- Node.js 20 or newer.
- npm 10 or newer.
- Rust stable and the wasm32-unknown-unknown target for Soroban contract builds.
- Docker Desktop or Docker Engine with Docker Compose v2.
- Git.
- Optional: VS Code with the extensions listed below.

## Quick Start Without Docker

```bash
git clone https://github.com/C-Address-Onboarding-Bridge/C-Address-Onboarding-Bridge-Backend.git
cd C-Address-Onboarding-Bridge-Backend
npm install
cp .env.example .env
npm run build
npm run test --workspaces
```

Expected test shape for a healthy checkout:

- API package tests pass with api.e2e, cex, moonpay, and soroban service coverage.
- SDK package tests pass with bridge client coverage.
- Contract tests should be run separately when contract code changes.

## Recommended Docker Compose Layout

The repository can adopt the following service model for one-command development:

```yaml
services:
  api:
    build:
      context: .
      dockerfile: Dockerfile
    command: npm run dev --workspace @c-address-bridge/api
    ports:
      - "3000:3000"
    env_file:
      - .env
    volumes:
      - .:/workspace
      - node_modules:/workspace/node_modules
    depends_on:
      - postgres
      - redis
      - soroban

  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: c_address_bridge
      POSTGRES_USER: c_address_bridge
      POSTGRES_PASSWORD: c_address_bridge
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"

  soroban:
    image: stellar/quickstart:testing
    command: --local --enable-soroban-rpc
    ports:
      - "8000:8000"

volumes:
  node_modules:
  postgres_data:
```

This file is a reference layout. If it is added as docker-compose.yml later, test it on Linux, macOS, and Windows before marking the setup as supported.

## One-Command Local Environment

After a Compose file is added, the intended workflow is:

```bash
cp .env.example .env
docker compose up --build
```

Then verify:

```bash
curl http://localhost:3000/health
npm run test --workspaces
```

## Environment Variables

Start from .env.example and keep secrets local. Common local variables should include:

| Variable | Purpose | Local example |
| --- | --- | --- |
| PORT | API server port | 3000 |
| HOST | API listen host | 0.0.0.0 |
| LOG_LEVEL | pino log level | debug |
| SOROBAN_RPC_URL | Soroban RPC endpoint | http://localhost:8000/soroban/rpc |
| SOROBAN_NETWORK_PASSPHRASE | Network passphrase | Standalone Network ; February 2017 |
| ONBOARDING_BRIDGE_CONTRACT_ID | Bridge contract ID | C... |
| API_KEY_HASH | Hash or configured value for local auth | local-only |
| MOONPAY_SECRET | Local webhook signing test secret | local-only |
| DATABASE_URL | Future Postgres URL | postgres://c_address_bridge:c_address_bridge@localhost:5432/c_address_bridge |
| REDIS_URL | Future cache URL | redis://localhost:6379 |

Never commit real API keys, provider credentials, seed phrases, private keys, or production contract secrets.

## Local Soroban Sandbox

For contract and transaction testing:

1. Start a local Soroban quickstart container.
2. Build the contract with cargo.
3. Deploy the WASM to the local network.
4. Save the local contract ID in .env.
5. Run API and SDK tests against local RPC only when the test suite explicitly expects local chain access.

Suggested commands:

```bash
rustup target add wasm32-unknown-unknown
cargo build -p onboarding-bridge --release --target wasm32-unknown-unknown
cargo test -p onboarding-bridge --features testutils
```

## VS Code Setup

Recommended extensions:

- ESLint.
- Prettier.
- rust-analyzer.
- Docker.
- GitHub Pull Requests.
- YAML.

Recommended workspace settings:

```json
{
  "editor.formatOnSave": true,
  "editor.defaultFormatter": "esbenp.prettier-vscode",
  "eslint.validate": ["javascript", "typescript"],
  "rust-analyzer.cargo.features": ["testutils"],
  "files.exclude": {
    "**/node_modules": true,
    "**/target": true
  }
}
```

## Git Hooks

Use hooks to catch avoidable issues before opening PRs:

```bash
git config core.hooksPath .githooks
```

Recommended pre-commit checks:

- npm run build for changed TypeScript packages when feasible.
- npm run test --workspaces before broad PRs.
- cargo test -p onboarding-bridge --features testutils when contract code changes.
- git diff --check to catch whitespace errors.

Hooks should stay fast. Put slower full-suite checks in CI or run them before pushing larger PRs.

## Mock Data and Seeds

Use deterministic non-secret data for local testing:

- fixed G-address and C-address placeholders.
- local-only API key values or hashes.
- sample quote requests for XLM and USDC.
- sample Moonpay, Transak, and CEX provider responses with personal data removed.
- sample transaction hashes and statuses.

Do not seed real provider credentials, private keys, seed phrases, production transaction data, or payment-provider personal data.

## Common Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| npm install fails | Node/npm version mismatch | Use Node 20+ and npm 10+ |
| /health is unreachable | API server not running or wrong port | Check PORT, HOST, and docker compose ps |
| Soroban RPC calls fail | Local sandbox not running or wrong network passphrase | Verify SOROBAN_RPC_URL and passphrase |
| Webhook tests fail | Signature uses parsed JSON instead of raw body | Sign the exact raw payload string |
| API requests return 401 | Missing or wrong API key | Check Authorization header and local auth config |
| Docker file watch does not reload on Windows | Filesystem watch limitations | Enable polling or restart the api service |
| Postgres port already in use | Local database already running | Change host port or stop the existing service |
| Redis port already in use | Local Redis already running | Change host port or stop the existing service |

## Cross-Platform Notes

- Linux: Docker Engine usually works directly; ensure your user can access the Docker socket.
- macOS: Docker Desktop file sharing must include the repository path.
- Windows: use WSL2-backed Docker Desktop for best filesystem and networking behavior.
- All platforms: avoid committing generated node_modules, target, coverage, or local database files.

## Validation Before PR

Run the strongest relevant checks before opening or updating a PR:

```bash
npm run build
npm run test --workspaces
cargo test -p onboarding-bridge --features testutils
git diff --check
```

If a command cannot be run in your environment, state that clearly in the PR and include the best substitute evidence, such as a focused manual check or documentation-only review.
