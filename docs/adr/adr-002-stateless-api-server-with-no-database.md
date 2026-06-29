# ADR-002: Stateless API server with no database

- Title: Stateless API server with no database
- Status: Accepted
- Date: 2026-06-29

## Context
The service must be horizontally scalable and easy to deploy. A full relational database would add operational overhead, schema management, and failover complexity for the initial version.

## Decision
Run the API server as a stateless service without a persistent database in the initial architecture. Keep state in the contract, external integrations, and transient caches where needed.

## Consequences
- Simplifies scaling and deployment.
- Makes the service easier to restart and recover.
- Limits support for complex relational queries and long-lived local state.

## Alternatives considered
- Introduce PostgreSQL or another database from the start.
- Keep session state in-memory on a single instance.

## Related ADRs
- [ADR-001: Use Soroban for smart contract execution](adr-001-use-soroban-for-smart-contract-execution.md)
- [ADR-008: Event-driven architecture for status updates](adr-008-event-driven-architecture-for-status-updates.md)
