# ADR-007: Use Stellar and soroban-sdk v26

- Title: Use Stellar and soroban-sdk v26
- Status: Accepted
- Date: 2026-06-29

## Context
The project needs a blockchain platform and SDK that support the contract features required by the bridge, while keeping the toolchain stable and well-supported.

## Decision
Use Stellar as the settlement network and target soroban-sdk v26 for contract development.

## Consequences
- Aligns the implementation with the current Soroban ecosystem.
- Enables access to the latest stable contract APIs and developer tooling.
- May require upgrades when the ecosystem evolves.

## Alternatives considered
- Use a different blockchain with a custom contract runtime.
- Pin to an older SDK version to reduce churn.

## Related ADRs
- [ADR-001: Use Soroban for smart contract execution](adr-001-use-soroban-for-smart-contract-execution.md)
