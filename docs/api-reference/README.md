# API Reference Package

This directory contains generated API reference artifacts:

- `openapi.json` exported from `api/src/openapi/spec.ts`
- `c-address-bridge.postman_collection.json` with runnable requests, success examples, error examples, auth scripts, and response tests
- `c-address-bridge.local.postman_environment.json` with network-switching variables

Regenerate after API changes:

```bash
npm run api-reference:generate --workspace api
```

Check for drift in CI:

```bash
npm run api-reference:check --workspace api
```

In Postman, import the collection and environment, then set `network` to `local`, `testnet`, or `mainnet`. The collection pre-request script copies the matching `{{network}}BaseUrl` into `{{baseUrl}}` and applies the `X-API-Key` header from `{{apiKey}}`.
