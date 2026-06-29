# ADR-004: Monorepo structure with npm workspaces

- Title: Monorepo structure with npm workspaces
- Status: Accepted
- Date: 2026-06-29

## Context
The project includes a Rust contract, TypeScript API, and SDK, and contributors need a shared development workflow with consistent tooling.

## Decision
Organize the repository as a monorepo with npm workspaces for the API and SDK while keeping the contract in a dedicated Rust package.

## Consequences
- Simplifies cross-project development and shared scripts.
- Reduces duplicate dependency management.
- Requires discipline around package boundaries and release coordination.

## Alternatives considered
- Keep each component in a separate repository.
- Use a different package manager or build system for the full stack.

## Related ADRs
- [ADR-001: Use Soroban for smart contract execution](adr-001-use-soroban-for-smart-contract-execution.md)
- [ADR-005: REST API with API key authentication](adr-005-rest-api-with-api-key-authentication.md)
