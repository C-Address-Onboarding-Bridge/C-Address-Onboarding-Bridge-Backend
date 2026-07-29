# Load Testing with k6

This document describes the k6 load test that is implemented and running in CI via
[`.github/workflows/benchmark.yml`](../.github/workflows/benchmark.yml).

---

## What Is Tested

The script (`api/tests/performance.k6.js`) runs a single **ramp-up → steady-state → ramp-down** scenario against two endpoints:

| Endpoint | Check |
|---|---|
| `GET /health/live` | HTTP 200 |
| `GET /api/v1/quote?sourceAsset=XLM&amount=1000000&targetAddress=<addr>` | HTTP 200 + body contains `estimatedFee`, `expectedReceive`, `feeBps` |

### Stages

| Stage | Duration | Virtual Users |
|---|---|---|
| Ramp-up | 20 s | 0 → `TARGET_VUS` |
| Steady state | `STEADY_SECONDS` (default `40s`) | `TARGET_VUS` (default `1` or `20` with prefix) |
| Ramp-down | 20 s | `TARGET_VUS` → 0 |

### Thresholds

| Metric | Threshold |
|---|---|
| `http_req_duration` p95 | < 500 ms |
| `http_req_failed` rate | < 1 % |
| `checks` pass rate | > 99 % |

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `API_BASE_URL` | `http://localhost:3001` | Base URL of the API under test |
| `API_KEY` | `benchmark-api-key` | `X-API-Key` header value (single key mode) |
| `API_KEY_PREFIX` | *(empty)* | When set, each VU uses `<prefix><vu-number>` as its key |
| `K6_TARGET_VUS` | `1` (or `20` when `API_KEY_PREFIX` is set) | Peak virtual-user count |
| `K6_STEADY_SECONDS` | `40s` | Duration of the steady-state stage |
| `K6_SLEEP_SECONDS` | `3` | Think-time sleep between iterations (seconds) |

---

## Running Locally

### Prerequisites

Install k6: https://grafana.com/docs/k6/latest/set-up/install-k6/

```bash
# macOS (Homebrew)
brew install k6

# Linux (Debian/Ubuntu)
sudo apt-key adv --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update && sudo apt-get install k6
```

### Start the API

```bash
docker compose up -d
```

### Run the test (defaults — 1 VU, warm cache)

```bash
k6 run api/tests/performance.k6.js
```

### Run with higher concurrency

```bash
K6_TARGET_VUS=20 K6_STEADY_SECONDS=60s k6 run api/tests/performance.k6.js
```

### Run against a remote environment

```bash
API_BASE_URL=https://api.staging.example.com \
API_KEY=your-staging-key \
K6_TARGET_VUS=50 \
k6 run api/tests/performance.k6.js
```

---

## CI Execution

The `benchmark.yml` workflow runs this test on demand (workflow dispatch) or on pushes that
touch the API source. It passes `API_BASE_URL` and `API_KEY` from repository secrets and
uploads the k6 summary JSON as a workflow artifact.

---

## Interpreting Results

k6 prints a summary at the end of the run. Look for:

- **`http_req_duration`** — latency distribution (p50/p90/p95/p99)
- **`http_req_failed`** — fraction of requests that returned a non-2xx status or a network error
- **`checks`** — pass rate for the inline assertions

A run is considered passing when all three thresholds above are met (shown as `✓` in the
summary). A failed threshold exits with a non-zero code, which fails the CI job.
