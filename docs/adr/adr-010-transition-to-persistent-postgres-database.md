# ADR-010: Transition to persistent PostgreSQL database

- Title: Transition to persistent PostgreSQL database
- Status: Accepted
- Date: 2026-07-29
- Supersedes: [ADR-002: Stateless API server with no database](adr-002-stateless-api-server-with-no-database.md)

## Context
ADR-002 deliberately deferred database adoption to keep the initial deployment simple and stateless. As the platform matured, several requirements made a persistent store unavoidable:

- **API key management** — issuing, rotating, and revoking API keys requires durable storage that survives restarts and scales across instances.
- **Audit logging with integrity guarantees** — `docs/audit-log-integrity.md` describes append-only tamper-evident logs that cannot live only in memory or on-chain.
- **Analytics and query history** — the analytics schema (`003_analytics_schema.ts`) records transaction-level data needed for reporting and abuse detection that the Soroban contract does not expose.
- **Idempotency keys** — preventing duplicate fund/offramp submissions across retried requests requires a shared, durable key store.
- **Webhook delivery tracking** — `api/src/services/webhookDelivery.ts` records delivery attempts and retries, which must outlive any single API process.

The deploy pipeline (`deploy.yml`) already runs `DATABASE_URL`-backed migrations against all three environments on every deploy, confirming the database is a first-class runtime dependency.

## Decision
Adopt PostgreSQL as the persistent data store for the API. The implementation uses:

- `api/src/services/db.ts` — connection pool and query interface
- `api/src/migrations/` — versioned migration runner (`001` through `005`) covering the initial schema, API keys, analytics, audit-log integrity, and query-optimisation indexes
- `api/src/migrations/runner.ts` — runs pending migrations at startup; `api/scripts/migrate.ts` provides a standalone CLI entrypoint
- `infrastructure/main.tf` — provisions the RDS instance; `DATABASE_URL` is injected per environment via Secrets Manager

## Consequences
- Horizontal scaling still works: the connection pool is stateless across pods; state lives in RDS.
- Schema changes require migrations; the runner enforces ordering and idempotency.
- Operational overhead increases: RDS provisioning, backups, failover, and connection-pool sizing must be managed.
- The service is no longer restartable without a database — `DATABASE_URL` is a hard runtime requirement in all environments.
- `docs/database.md` documents the operational model, backup strategy, and connection-pool configuration.

## Alternatives considered
- Continue deferring the database and storing API keys/audit records in external services (e.g., DynamoDB, Redis). Rejected: adds more vendor dependencies and does not support relational queries needed for analytics.
- Use a managed serverless database (Aurora Serverless). Not chosen for the initial rollout due to cold-start latency concerns, but remains a valid upgrade path.

## Related ADRs
- [ADR-002: Stateless API server with no database](adr-002-stateless-api-server-with-no-database.md) — superseded by this decision
- [ADR-001: Use Soroban for smart contract execution](adr-001-use-soroban-for-smart-contract-execution.md)
- [ADR-009: Security architecture — defense-in-depth](adr-009-security-architecture.md)
