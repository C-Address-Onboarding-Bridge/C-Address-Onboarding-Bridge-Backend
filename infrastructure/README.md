# Infrastructure

Terraform configuration for the C-Address Onboarding Bridge backend.

## Per-environment initialization

Remote state is keyed per environment to prevent cross-environment state
collisions. Initialize Terraform for a specific environment using
`-backend-config`:

```bash
# Development
terraform init -backend-config=env/dev.backend.hcl

# Staging
terraform init -backend-config=env/staging.backend.hcl

# Production
terraform init -backend-config=env/production.backend.hcl
```

After initialization, plan and apply as usual:

```bash
terraform plan -var environment=<env>
terraform apply -var environment=<env>
```

## Backend configuration

The S3 backend (`infrastructure/main.tf`) defines the bucket, region,
DynamoDB locking table, and encryption. The `key` is intentionally
omitted and supplied per environment via `-backend-config` so that each
environment (dev, staging, production) uses its own state file.

## CI validation

The `Terraform validate` job in `.github/workflows/ci.yml` runs on every push
and pull request, without backend credentials:

```sh
terraform fmt -check -recursive infrastructure
cd infrastructure     && terraform init -backend=false && terraform validate
cd infrastructure/cdn && terraform init -backend=false && terraform validate
```

Run the same commands locally before opening a PR.
