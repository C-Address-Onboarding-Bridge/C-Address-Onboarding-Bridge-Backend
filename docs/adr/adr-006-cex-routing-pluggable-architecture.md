# ADR-006: CEX routing pluggable architecture

- Title: CEX routing pluggable architecture
- Status: Accepted
- Date: 2026-06-29

## Context
The bridge needs to support multiple centralized exchanges and may add or replace providers over time. Hard-coding route logic would create coupling and slow iterations.

## Decision
Model CEX integrations behind a pluggable routing interface so providers can be added or swapped without changing the core orchestration flow.

## Consequences
- Improves extensibility and testability.
- Supports future provider onboarding.
- Requires a stable abstraction for provider-specific differences.

## Alternatives considered
- Single hard-coded provider implementation.
- A shared monolithic routing module for every exchange.

## Related ADRs
- [ADR-005: REST API with API key authentication](adr-005-rest-api-with-api-key-authentication.md)
- [ADR-008: Event-driven architecture for status updates](adr-008-event-driven-architecture-for-status-updates.md)
