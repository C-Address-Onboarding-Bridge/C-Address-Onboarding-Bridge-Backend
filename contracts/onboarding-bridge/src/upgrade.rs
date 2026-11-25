//! Governed WASM upgrade support for [`crate::ProposalAction::Upgrade`].
//!
//! The upgrade is only reachable through `execute`, which has already checked
//! the multisig threshold and the `MIN_EXEC_DELAY` transparency window.

use soroban_sdk::{contractevent, BytesN, Env};

use crate::DataKey;

#[contractevent(topics = ["upgraded"], data_format = "vec")]
#[derive(Clone)]
pub struct Upgraded {
    pub old_version: u32,
    pub new_version: u32,
    pub wasm_hash: BytesN<32>,
}

/// Replaces the live WASM with `wasm_hash`, bumps `DataKey::Version` and emits
/// an `upgraded` event. Instance and persistent storage are preserved.
pub(crate) fn apply_upgrade(env: &Env, wasm_hash: BytesN<32>) {
    let old_version: u32 = env
        .storage()
        .instance()
        .get(&DataKey::Version)
        .unwrap_or(0);
    let new_version = old_version + 1;
    env.storage().instance().set(&DataKey::Version, &new_version);
    env.deployer()
        .update_current_contract_wasm(wasm_hash.clone());
    Upgraded {
        old_version,
        new_version,
        wasm_hash,
    }
    .publish(env);
}
