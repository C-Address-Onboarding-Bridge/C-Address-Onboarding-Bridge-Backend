#![cfg(test)]

extern crate std;

use soroban_sdk::{
    testutils::{Address as _, Ledger},
    Address, Env, Vec,
};

use super::*;

fn new_bridge(env: &Env) -> OnboardingBridgeClient<'static> {
    env.mock_all_auths_allowing_non_root_auth();
    let id = env.register_contract(None, OnboardingBridge);
    let client = OnboardingBridgeClient::new(env, &id);
    unsafe { core::mem::transmute(client) }
}

fn distinct_admins(env: &Env, n: u32) -> Vec<Address> {
    let mut v: Vec<Address> = Vec::new(env);
    for _ in 0..n {
        v.push_back(Address::generate(env));
    }
    v
}

// #1083: duplicate admin addresses are rejected.

#[test]
fn test_initialize_rejects_duplicate_admins() {
    let env = Env::default();
    let bridge = new_bridge(&env);
    let a = Address::generate(&env);
    let b = Address::generate(&env);
    let admins = Vec::from_array(&env, [a.clone(), a, b]);
    let res = bridge.try_initialize(&admins, &3, &100, &1000, &1, &i128::MAX);
    assert_eq!(res, Err(Ok(BridgeError::DuplicateAdmin)));
}

#[test]
fn test_initialize_accepts_distinct_admins() {
    let env = Env::default();
    let bridge = new_bridge(&env);
    let admins = distinct_admins(&env, 3);
    bridge.initialize(&admins, &3, &100, &1000, &1, &i128::MAX);
}

#[test]
fn test_rotate_admins_rejects_duplicate_admins() {
    let env = Env::default();
    let bridge = new_bridge(&env);
    let admins = distinct_admins(&env, 1);
    bridge.initialize(&admins, &1, &100, &1000, &1, &i128::MAX);
    let a = Address::generate(&env);
    let dup = Vec::from_array(&env, [a.clone(), a]);
    let pid = bridge.propose(
        &admins.get_unchecked(0),
        &ProposalAction::RotateAdmins(dup),
        &1000,
    );
    env.ledger()
        .set_sequence_number(env.ledger().sequence() + MIN_EXEC_DELAY);
    assert!(bridge.try_execute(&pid).is_err());
}
