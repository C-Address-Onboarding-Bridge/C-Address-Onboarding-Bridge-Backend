# Secrets Management

The API can hydrate configuration from a centralized vault before `config` is built. Plain environment variables still work for tests and simple local runs, but deployed services should set `SECRETS_PROVIDER` and read only the secrets assigned to their service.

## Providers

Set one of:

- `SECRETS_PROVIDER=aws` for AWS Secrets Manager via the `aws` CLI/runtime role.
- `SECRETS_PROVIDER=gcp` for GCP Secret Manager via the `gcloud` CLI/workload identity.
- `SECRETS_PROVIDER=vault` for HashiCorp Vault via the `vault` CLI/token or role auth.
- `SECRETS_PROVIDER=local-encrypted` for encrypted local development files.
- `SECRETS_PROVIDER=env` to use process environment only.

Common settings:

- `SECRETS_PATH_PREFIX=c-address-bridge/api` controls the vault path prefix.
- `SECRETS_SERVICE_NAME=api|worker|deploy` enforces least-privilege loading.
- `SECRETS_STRICT=true` fails startup when any mapped secret cannot be read.
- `SECRETS_AUDIT_LOG=logs/secrets-audit.jsonl` records every secret access result without secret values.

## Schema

The source of truth is `api/src/secrets/schema.ts`. Every runtime env var used by the API config is mapped to a provider path, service owner, sensitivity flag, and rotation interval. Critical secrets include:

- `API_KEYS`
- `SOROBAN_RPC_URL` / `SOROBAN_RPC_URLS`
- `MOONPAY_API_KEY`
- `MOONPAY_SECRET_KEY`
- `TRANSAK_API_KEY`
- `TRANSAK_WEBHOOK_SECRET`
- `REDIS_URL`
- `DATABASE_URL`
- `LOGTAIL_TOKEN`
- `WEBHOOK_SIGNING_SECRET`

## Local Encrypted Secrets

Create a local plaintext file, encrypt it, then delete the plaintext file:

```bash
export LOCAL_SECRETS_KEY="use-a-long-random-passphrase"
cat > .secrets.local.json <<'JSON'
{
  "API_KEYS": "dev-api-key",
  "MOONPAY_API_KEY": "replace-me",
  "MOONPAY_SECRET_KEY": "replace-me"
}
JSON
npm run secrets:encrypt
rm .secrets.local.json
```

Run with:

```bash
SECRETS_PROVIDER=local-encrypted LOCAL_SECRETS_KEY="$LOCAL_SECRETS_KEY" npm run dev --workspace api
```

`.secrets.local.json`, `.secrets.local.enc`, and the audit log are ignored by git.

## Rotation

Generate replacement material for internally managed critical secrets:

```bash
npm run secrets:rotate -- API_KEYS
npm run secrets:rotate -- WEBHOOK_SIGNING_SECRET
SECRETS_PROVIDER=aws npm run secrets:rotate -- API_KEYS --apply
```

For internally managed secrets, add `--apply` with `SECRETS_PROVIDER=aws|gcp|vault` to write the generated value directly to the configured vault path. The monthly `.github/workflows/secrets-rotation.yml` workflow automates `API_KEYS` and `WEBHOOK_SIGNING_SECRET` rotation when `ROTATE_SECRETS_ENABLED=true` and provider credentials are configured. For third-party or infrastructure-managed secrets, use the provider console/API to create the new value, update the vault entry at the mapped schema path, deploy/restart the affected service, verify health checks, then revoke the old credential.

Recommended schedules:

- `API_KEYS` and `WEBHOOK_SIGNING_SECRET`: every 30 days.
- RPC, database, Redis, provider, and logging tokens: every 90 days or immediately after staff/vendor access changes.

## Emergency Rotation

1. Freeze deploys that could reintroduce leaked values.
2. Identify the schema entry and all services with access.
3. Generate or obtain a replacement value.
4. Write the replacement to the cloud vault path under `SECRETS_PATH_PREFIX`.
5. Restart only affected services with `SECRETS_STRICT=true`.
6. Confirm `/health`, provider callbacks, and smoke tests pass.
7. Revoke the old value at the upstream provider.
8. Preserve `SECRETS_AUDIT_LOG` and cloud audit logs for incident review.

## Pre-Commit Secret Detection

The Husky pre-commit hook runs:

```bash
node scripts/secrets.mjs scan --staged
```

The scanner blocks common API keys, private keys, bearer tokens, and credentialed database/Redis URLs before they are committed. CI can run the same scanner with:

```bash
npm run secrets:scan
```
