# ADR-001: Use Soroban for smart contract execution

- Title: Use Soroban for smart contract execution
- Status: Accepted
- Date: 2026-06-29

## Context
The bridge needs a trust-minimized execution layer for onboarding and transfer orchestration. The team wants smart contract logic that can be audited, upgraded carefully, and invoked from the backend without depending on custom off-chain state transitions.

## Decision
Use Soroban as the execution engine for the bridge contract and keep business logic that requires shared state in the contract where possible.

## Consequences
- Enables deterministic on-chain execution and auditability.
- Keeps settlement and bridge invariants aligned with the blockchain.
- Requires familiarity with Stellar and Soroban tooling for contributors.

## Alternatives considered
- Build a fully off-chain orchestration system with no smart contract runtime.
- Use another blockchain runtime, which would increase integration and operational complexity.

## Related ADRs
- [ADR-007: Use Stellar and soroban-sdk v26](adr-007-use-stellar-and-soroban-sdk-v26.md)
