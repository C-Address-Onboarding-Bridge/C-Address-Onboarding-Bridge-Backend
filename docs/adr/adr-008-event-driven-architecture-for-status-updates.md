# ADR-008: Event-driven architecture for status updates

- Title: Event-driven architecture for status updates
- Status: Accepted
- Date: 2026-06-29

## Context
The bridge needs to surface progress and lifecycle updates for deposits, transfers, and off-ramp events. A simple request-response model is insufficient for long-running workflows and real-time experiences.

## Decision
Adopt an event-driven architecture for status updates, with WebSocket delivery for live push notifications. WebSocket support is implemented and live: `api/src/services/websocket.ts` mounts a `/ws` upgrade endpoint backed by the `ws` production dependency, with a dedicated test suite in `api/src/__tests__/websocket.test.ts`.

## Consequences
- Supports asynchronous workflows and better observability.
- Real-time clients are supported today via the WebSocket endpoint.
- Adds some complexity around event schema versioning and delivery guarantees.

## Alternatives considered
- Polling-based status updates only.
- Tight coupling status updates to synchronous API responses.

## Related ADRs
- [ADR-002: Stateless API server with no database](adr-002-stateless-api-server-with-no-database.md)
- [ADR-006: CEX routing pluggable architecture](adr-006-cex-routing-pluggable-architecture.md)
