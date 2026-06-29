# ADR-003: Fee model with basis points

- Title: Fee model with basis points
- Status: Accepted
- Date: 2026-06-29

## Context
The bridge needs a predictable and transparent fee structure that can be adjusted safely across environments and asset flows without introducing rounding ambiguity.

## Decision
Represent fees in basis points and expose them through configuration so the contract and API share the same fee semantics.

## Consequences
- Keeps fee changes explicit and auditable.
- Enables consistent calculations across backend and contract.
- Requires contributors to understand the basis-point convention.

## Alternatives considered
- Fixed flat fees per route.
- Percentage-based fees expressed directly as decimals.

## Related ADRs
- [ADR-001: Use Soroban for smart contract execution](adr-001-use-soroban-for-smart-contract-execution.md)
