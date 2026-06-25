# Fuzz Testing

Property-based fuzz tests for the `onboarding-bridge` Soroban contract.
These are regular Rust binaries (not wasm) using the soroban testenv.

## Running

```bash
cd contracts/onboarding-bridge/fuzz

# Run all three targets
cargo run --bin fuzz_fee_calculation
cargo run --bin fuzz_fund_sequence
cargo run --bin fuzz_admin_ops

# Run with a custom PRNG seed (u64 decimal)
cargo run --bin fuzz_fee_calculation -- 123456789
```

## Targets

| Binary | Iterations | What it tests |
|---|---|---|
| `fuzz_fee_calculation` | 100 000 | Pure fee arithmetic properties (no env) |
| `fuzz_fund_sequence` | 1 000 | `accumulated_fees == sum of fees` across random call sequences |
| `fuzz_admin_ops` | 500 | `set_fee / fund / withdraw` interleavings; fees never negative, withdraw accounting correct |

## CI time budget

- `fuzz_fee_calculation`: ~1 s (pure math, no env)
- `fuzz_fund_sequence`: ~60–120 s (env creation is expensive)
- `fuzz_admin_ops`: ~30–60 s

Recommended CI budget: **5 minutes total**. Gate PRs on all three passing.

## Adding new targets

1. Create `src/fuzz_<name>.rs` with a `main()` that panics on property violation.
2. Add a `[[bin]]` entry in `Cargo.toml`.
3. Document it in this table.
