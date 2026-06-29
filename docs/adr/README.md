# Architecture Decision Records

This directory captures the key architectural decisions for the C-Address Onboarding Bridge backend.

## ADR Index

- [ADR-001: Use Soroban for smart contract execution](adr-001-use-soroban-for-smart-contract-execution.md)
- [ADR-002: Stateless API server with no database](adr-002-stateless-api-server-with-no-database.md)
- [ADR-003: Fee model with basis points](adr-003-fee-model-with-basis-points.md)
- [ADR-004: Monorepo structure with npm workspaces](adr-004-monorepo-structure-with-npm-workspaces.md)
- [ADR-005: REST API with API key authentication](adr-005-rest-api-with-api-key-authentication.md)
- [ADR-006: CEX routing pluggable architecture](adr-006-cex-routing-pluggable-architecture.md)
- [ADR-007: Use Stellar and soroban-sdk v26](adr-007-use-stellar-and-soroban-sdk-v26.md)
- [ADR-008: Event-driven architecture for status updates](adr-008-event-driven-architecture-for-status-updates.md)

## ADR Template

Use [template.md](template.md) for new decisions.

## Review Process

1. Draft the ADR in this directory with the template.
2. Link the ADR to related decisions in the index and body.
3. Submit the change for review with context for trade-offs and migration impact.
4. Merge once the team agrees on the decision and consequences.
