# Prometheus Scrape Authentication

Prometheus scrapes `/metrics` using a dedicated API key with only the
`metrics:read` scope. Create the key through the API key management endpoint
using an existing key authorized for `admin:keys`:

```sh
curl -sS -X POST http://localhost:3001/api/v1/keys \
  -H "X-API-Key: $ADMIN_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"name":"prometheus-scrape","scopes":["metrics:read"]}'
```

The response includes `rawKey` once. Store that value by itself in a file
outside the repository, for example `/secure/prometheus-scrape-key`, and set
`PROMETHEUS_SCRAPE_API_KEY_FILE` to that file's path in the environment used by
Docker Compose. Restrict access to the file and do not commit it.

Start the stack with both compose files:

```sh
docker compose -f docker-compose.yml -f docker-compose.observability.yml up -d
```

Confirm the scrape is healthy:

```sh
curl -fsS 'http://localhost:9090/api/v1/targets' \
  | jq -e '.data.activeTargets[] | select(.labels.job == "c-address-bridge" and .health == "up")'
```
