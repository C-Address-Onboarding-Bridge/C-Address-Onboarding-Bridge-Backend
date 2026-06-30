# Multi-Language SDK Examples

Runnable integration examples for the C-Address Bridge API in **Python**, **Rust**, **Go**, and **Java**. Each language ships a thin HTTP client library and a `main` program that exercises the core flows:

| Flow | Endpoint |
|------|----------|
| Client setup | `BRIDGE_BASE_URL`, optional `BRIDGE_API_KEY` |
| Get quote | `GET /api/v1/quote` |
| Fund C-address | `POST /api/v1/fund/prepare` → sign → `POST /api/v1/fund` |
| Transaction status | `GET /api/v1/status/:hash` |
| MoonPay URL | `POST /api/v1/offramp/moonpay` |
| Transak URL | `POST /api/v1/offramp/transak` |
| Error handling | Typed errors per language |

Examples run against a lightweight mock server by default — no live API or secrets required.

---

## Quick start (local)

```bash
# Terminal 1 — mock API
node examples/mock-server/server.mjs

# Terminal 2 — pick a language
export BRIDGE_BASE_URL=http://localhost:3099

# Python
cd examples/python && python main.py

# Rust
cd examples/rust && cargo run --example bridge

# Go
cd examples/go && go run .

# Java
cd examples/java && mvn -q exec:java
```

---

## Docker (all languages)

```bash
cd examples
docker compose up --build
```

This starts the mock server and runs each language example in sequence.

---

## Package managers

| Language | Install / build |
|----------|-----------------|
| Python | `pip install -e .` (stdlib only, no deps) |
| Rust | `cargo build --example bridge` |
| Go | `go build .` |
| Java | `mvn package` |

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BRIDGE_BASE_URL` | `http://localhost:3099` | Bridge API base URL |
| `BRIDGE_API_KEY` | *(none)* | Optional `X-API-Key` header |
| `MOCK_PORT` | `3099` | Mock server listen port |

Point `BRIDGE_BASE_URL` at a running local API (`http://localhost:3001`) or production endpoint when you are ready to integrate against a real backend.

---

## CI

The `examples` workflow in `.github/workflows/examples.yml` compiles and runs every example against the mock server on each PR.

---

## TypeScript SDK

For JavaScript/TypeScript projects, use the official [`@c-address-bridge/sdk`](../sdk) package. These multi-language examples mirror its REST surface for wallets and dApps built in other ecosystems.
