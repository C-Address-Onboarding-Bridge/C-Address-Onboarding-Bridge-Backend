# Upgrade & Migration Guide

This document covers how to upgrade the `onboarding-bridge` Soroban contract
after a soroban-sdk version bump or a storage schema change.

---

## Concepts

| Term | Meaning |
|------|---------|
| `Version` | User-visible contract version stored in `DataKey::Version`. Increment per release. |
| `ProposalAction::Upgrade` | Governed proposal action that replaces the live WASM in-place via `env.deployer().update_current_contract_wasm()`. |

Soroban's `env.deployer().update_current_contract_wasm()` replaces WASM in-place
while keeping all instance storage intact. The contract does **not** expose a
direct `upgrade()` entrypoint; instead, an upgrade is performed through the
governed proposal flow: an admin proposes `ProposalAction::Upgrade(new_wasm_hash)`,
approvers approve it, and once the approval threshold is met anyone can `execute`
it. Execution calls `update_current_contract_wasm` with the new hash.

There is no `migrate()` entrypoint and no on-chain `schema_version` /
`SCHEMA_VERSION` / `DataKey::SchemaVersion`. Storage layout changes must be
handled by the new WASM itself (e.g. lazily writing defaults on read) or by a
redeploy, since the contract has no migration hook.

---

## Upgrade Procedure

### 1. soroban-sdk version bump (no storage changes)

1. Update `Cargo.toml`:
   ```toml
   soroban-sdk = { version = "<new_version>" }
   ```
2. Build and test:
   ```bash
   cargo build --target wasm32v1-none --release
   cargo test
   ```
3. Deploy the new WASM and note the hash:
   ```bash
   stellar contract install \
     --wasm target/wasm32v1-none/release/onboarding_bridge.wasm \
     --source <admin-secret> \
     --rpc-url <rpc-url> \
     --network-passphrase "<passphrase>"
   # outputs: <new_wasm_hash>
   ```
4. Propose the upgrade on the live contract (admin only):
   ```bash
   stellar contract invoke \
     --id <contract-id> \
     --source <admin-secret> \
     --rpc-url <rpc-url> \
     --network-passphrase "<passphrase>" \
     -- propose \
        --proposer <admin-address> \
        --action '{"Upgrade": "<new_wasm_hash>"}'
   # outputs: <proposal_id>
   ```
5. Approve the proposal until the threshold is met (each approver):
   ```bash
   stellar contract invoke \
     --id <contract-id> \
     --source <approver-secret> \
     --rpc-url <rpc-url> \
     --network-passphrase "<passphrase>" \
     -- approve --approver <approver-address> --proposal_id <proposal_id>
   ```
6. Execute the proposal once approved:
   ```bash
   stellar contract invoke \
     --id <contract-id> \
     --source <any-secret> \
     --rpc-url <rpc-url> \
     --network-passphrase "<passphrase>" \
     -- execute --proposal_id <proposal_id>
   ```
7. Verify the contract still works:
   ```bash
   stellar contract invoke --id <contract-id> ... -- version
   ```

No migration call is needed when the storage schema has not changed.

### Restoring archived state

The contract renews instance and persistent entries before they approach their
archive threshold. If an entry has already been archived, include it in the
transaction footprint and restore it before invoking the contract:

Build a transaction with a `RestoreFootprint` operation for the archived
entries, submit it with the administrator source account, and then retry the
contract invocation.

Restore the instance entry before any getter or mutating call that depends on
contract configuration. Restore individual persistent funding, proposal, or
analytics entries only when replaying or querying those records; normal calls
renew entries that are still live.

---

### 2. Storage schema change (new or renamed keys / changed value types)

The contract has no `migrate()` entrypoint and no on-chain schema version, so
there is no in-place migration hook. Choose one of:

- **Lazy defaults in the new WASM.** Ship code that treats a missing key as its
default value on read and writes it on the next mutation. Follow all steps in
§1 to roll the new WASM out through the governed upgrade flow.
- **Redeploy.** If the change cannot be handled lazily, deploy a fresh contract
with `stellar contract deploy`, re-run `initialize`, and migrate off-chain state
(funding records, proposals) out of band. Soroban contracts are immutable once
deployed, so a redeploy is the only way to change storage layout that the new
WASM cannot reconcile.

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

---

## Changelog

| Contract Version | soroban-sdk | Notes |
|-----------------|-------------|-------|
| 1 | 26.0.1 | Initial release |
