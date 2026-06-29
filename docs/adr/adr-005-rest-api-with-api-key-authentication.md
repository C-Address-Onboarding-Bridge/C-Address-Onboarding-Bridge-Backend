# ADR-005: REST API with API key authentication

- Title: REST API with API key authentication
- Status: Accepted
- Date: 2026-06-29

## Context
The backend needs a straightforward integration surface for clients and operators, while keeping authentication simple and compatible with existing HTTP tooling.

## Decision
Expose the service through a REST API and protect sensitive endpoints with API key authentication.

## Consequences
- Lowers the barrier to integration for external clients.
- Keeps the API easy to document and test.
- Offers less flexibility than OAuth or mTLS for advanced identity models.

## Alternatives considered
- GraphQL for the public interface.
- Mutual TLS-only authentication.

## Related ADRs
- [ADR-004: Monorepo structure with npm workspaces](adr-004-monorepo-structure-with-npm-workspaces.md)
- [ADR-006: CEX routing pluggable architecture](adr-006-cex-routing-pluggable-architecture.md)
