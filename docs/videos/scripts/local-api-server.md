# Local API Server — Video Script

**Target runtime:** 6 minutes

## Storyboard

| Scene | Visual | Narration |
|-------|--------|-----------|
| 1 | Prerequisites table | "You need Node 20+, Docker Compose v2, and optionally Rust for contracts." |
| 2 | `docker compose ps` | "Four services: api, postgres, redis, soroban-quickstart." |
| 3 | API logs | "The API hot-reloads on source changes via tsx watch." |
| 4 | `./scripts/smoke-test.sh` | "Run the smoke test to verify quote and health endpoints." |

## Terminal commands

```bash
docker compose up -d
docker compose ps
curl -s http://localhost:3001/health
curl -s 'http://localhost:3001/api/v1/quote?sourceAsset=XLM&amount=10000000&targetAddress=CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4' -H 'X-API-Key: dev-key' | head -c 200
echo
```
