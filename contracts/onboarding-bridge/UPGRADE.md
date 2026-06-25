# Upgrade & Migration Guide

This document covers how to upgrade the `onboarding-bridge` Soroban contract
after a soroban-sdk version bump or a storage schema change.

---

## Concepts

| Term | Meaning |
|------|---------|
| `Version` | User-visible contract version stored in `DataKey::Version`. Increment per release. |
| `SchemaVersion` | On-chain storage schema version stored in `DataKey::SchemaVersion`. Increment only when a storage key or its value type changes. |
| `SCHEMA_VERSION` | Compile-time constant in `lib.rs`. Must match the highest schema version the code understands. |

Soroban's `env.deployer().update_current_contract_wasm()` replaces WASM in-place
while keeping all instance storage intact. The `upgrade()` function wraps this
call and requires admin auth.

---

## Upgrade Procedure

### 1. soroban-sdk version bump (no storage changes)

1. Update `Cargo.toml`:
   ```toml
   soroban-sdk = { version = "<new_version>" }
   ```
2. Build and test:
   ```bash
   cargo build --target wasm32-unknown-unknown --release
   cargo test
   ```
3. Deploy the new WASM and note the hash:
   ```bash
   soroban contract install \
     --wasm target/wasm32-unknown-unknown/release/onboarding_bridge.wasm \
     --source <admin-secret> \
     --rpc-url <rpc-url> \
     --network-passphrase "<passphrase>"
   # outputs: <new_wasm_hash>
   ```
4. Call `upgrade` on the live contract (admin only):
   ```bash
   soroban contract invoke \
     --id <contract-id> \
     --source <admin-secret> \
     --rpc-url <rpc-url> \
     --network-passphrase "<passphrase>" \
     -- upgrade --new_wasm_hash <new_wasm_hash>
   ```
5. Verify the contract still works:
   ```bash
   soroban contract invoke --id <contract-id> ... -- version
   soroban contract invoke --id <contract-id> ... -- schema_version
   ```

No `migrate` call is needed when the schema has not changed.

---

### 2. Storage schema change (new or renamed keys / changed value types)

Follow all steps in §1, then additionally:

1. Bump `SCHEMA_VERSION` in `lib.rs`:
   ```rust
   pub const SCHEMA_VERSION: u32 = 2; // was 1
   ```
2. Add migration logic in `migrate()`:
   ```rust
   if on_chain < 2 {
       // e.g. write default value for a new key
       env.storage().instance().set(&DataKey::NewKey, &default_value);
   }
   ```
3. After calling `upgrade`, call `migrate` (admin only):
   ```bash
   soroban contract invoke \
     --id <contract-id> \
     --source <admin-secret> \
     --rpc-url <rpc-url> \
     --network-passphrase "<passphrase>" \
     -- migrate
   ```
4. Confirm `schema_version` returns the new value:
   ```bash
   soroban contract invoke --id <contract-id> ... -- schema_version
   # expect: 2
   ```

`migrate` is idempotent — calling it again on an already-migrated contract is
safe (it writes the same schema version and returns `Ok`).

---

## CI: compatibility with latest soroban-sdk

Add a matrix job that tests against the pinned version and the latest published
version:

```yaml
# .github/workflows/ci.yml (excerpt)
strategy:
  matrix:
    sdk: ["26.0.1", "latest"]
steps:
  - name: Pin soroban-sdk version
    run: |
      if [ "${{ matrix.sdk }}" != "latest" ]; then
        sed -i 's/soroban-sdk = { version = "[^"]*"/soroban-sdk = { version = "${{ matrix.sdk }}"/' \
          contracts/onboarding-bridge/Cargo.toml
      fi
  - run: cargo test --manifest-path contracts/onboarding-bridge/Cargo.toml
```

---

## Error reference

| Error | Code | When |
|-------|------|------|
| `AlreadyInitialized` | 1 | `initialize` called twice |
| `NotInitialized` | 2 | Any function called before `initialize` |
| `Unauthorized` | 3 | Non-admin calls admin-only function |
| `InvalidFeeBps` | 4 | `fee_bps > 10000` |
| `ZeroAmount` | 5 | `amount <= 0` in `fund_c_address` |
| `InsufficientFees` | 6 | Withdrawal exceeds accumulated fees |
| `IncompatibleSchema` | 7 | On-chain schema version > code's `SCHEMA_VERSION` |

---

## Changelog

| Contract Version | Schema Version | soroban-sdk | Notes |
|-----------------|---------------|-------------|-------|
| 1 | 1 | 26.0.1 | Initial release |
