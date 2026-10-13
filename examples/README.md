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
| CEX withdrawal routing | `POST /api/v1/cex/route` |
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

## Idempotency (safe retries)

The fund submission (`POST /api/v1/fund`) and CEX withdrawal routing
(`POST /api/v1/cex/route`) endpoints are **non-idempotent**: a retried
request can otherwise be submitted twice. Every example in this folder sends
a UUIDv4 `X-Idempotency-Key` header on those calls (the server's idempotency
middleware de-duplicates by that key), so a retry does not cause a double
submission. A fresh key is generated per logical operation:

- **Python** — `generate_idempotency_key()`; pass the same key back on a
  retry via `submit_signed_xdr(..., idempotency_key=KEY)` or
  `route_cex_withdrawal(idempotency_key=KEY, ...)`.
- **Go** — `caddressbridge.GenerateIdempotencyKey()`.
- **Rust** — `c_address_bridge::BridgeClient::generate_idempotency_key()`.
- **Java** — `BridgeClient.generateIdempotencyKey()`.

Reuse the **same** key when retrying the same operation; generate a new one
for a new logical operation. The mock server ignores the header, so all
examples still run end-to-end locally.

---

## CI

The `examples` workflow in `.github/workflows/examples.yml` compiles and runs every example against the mock server on each PR.

---

## TypeScript SDK

For JavaScript/TypeScript projects, use the official [`@c-address-bridge/sdk`](../sdk) package. These multi-language examples mirror its REST surface for wallets and dApps built in other ecosystems.
