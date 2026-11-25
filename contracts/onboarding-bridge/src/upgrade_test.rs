#![cfg(test)]

use soroban_sdk::{
    testutils::{Address as _, Ledger},
    vec, Address, BytesN, Env,
};

use super::*;

fn setup() -> (Env, OnboardingBridgeClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let id = env.register_contract(None, OnboardingBridge);
    let client = OnboardingBridgeClient::new(&env, &id);
    let admin = Address::generate(&env);
    client.initialize(&vec![&env, admin.clone()], &1, &100, &1000, &1, &i128::MAX);
    (env, client, admin)
}

#[test]
fn upgrade_is_rejected_before_execution_delay() {
    let (env, bridge, admin) = setup();
    let hash = BytesN::from_array(&env, &[7u8; 32]);
    let id = bridge.propose(&admin, &ProposalAction::Upgrade(hash), &1000);
    bridge.approve(&admin, &id);
    // Upgrade is a sensitive action: executing in the proposal ledger must
    // hit the timelock, and must not bump the version.
    assert!(bridge.try_execute(&id).is_err());
    assert_eq!(bridge.version(), 1);
    env.ledger().with_mut(|l| l.sequence_number += MIN_EXEC_DELAY);
    assert!(bridge.try_execute(&id).is_err() || bridge.version() == 2);
}

#[test]
fn only_admins_can_propose_upgrade() {
    let (env, bridge, _admin) = setup();
    let outsider = Address::generate(&env);
    let hash = BytesN::from_array(&env, &[7u8; 32]);
    assert!(bridge
        .try_propose(&outsider, &ProposalAction::Upgrade(hash), &1000)
        .is_err());
}
