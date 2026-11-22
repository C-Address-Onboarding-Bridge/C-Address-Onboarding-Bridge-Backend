#![cfg(test)]

use soroban_sdk::{testutils::Address as _, Address, Env, String, Vec};

use super::*;

fn admins(env: &Env, count: u32) -> Vec<Address> {
    let mut v: Vec<Address> = Vec::new(env);
    for _ in 0..count {
        v.push_back(Address::generate(env));
    }
    v
}

#[test]
#[should_panic(expected = "Auth")]
fn test_fund_c_address_requires_source_auth() {
    let env = Env::default();
    let id = env.register_contract(None, OnboardingBridge);
    let client = OnboardingBridgeClient::new(&env, &id);
    let source = Address::generate(&env);
    let target = env.register_contract(None, OnboardingBridge);
    let token = env.register_contract(None, OnboardingBridge);
    client.fund_c_address(&source, &target, &token, &1000, &String::from_str(&env, "m"));
}

#[test]
#[should_panic(expected = "Auth")]
fn test_initialize_requires_admin_auth() {
    let env = Env::default();
    let id = env.register_contract(None, OnboardingBridge);
    let client = OnboardingBridgeClient::new(&env, &id);
    let a = admins(&env, 2);
    client.initialize(&a, &2, &30, &1000, &1, &i128::MAX);
}

#[test]
fn test_initialize_twice_returns_already_initialized() {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register_contract(None, OnboardingBridge);
    let client = OnboardingBridgeClient::new(&env, &id);
    let a = admins(&env, 2);
    client.initialize(&a, &2, &30, &1000, &1, &i128::MAX);
    let res = client.try_initialize(&a, &2, &50, &1000, &1, &i128::MAX);
    assert_eq!(res, Err(Ok(BridgeError::AlreadyInitialized)));
}

#[test]
fn test_batch_fund_rejected_when_paused() {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register_contract(None, OnboardingBridge);
    let client = OnboardingBridgeClient::new(&env, &id);
    let a = admins(&env, 1);
    client.initialize(&a, &1, &30, &1000, &1, &i128::MAX);
    env.as_contract(&id, || {
        env.storage().instance().set(&DataKey::Paused, &true);
    });

    let source = Address::generate(&env);
    let target = env.register_contract(None, OnboardingBridge);
    let token = env.register_contract(None, OnboardingBridge);
    let targets = Vec::from_array(&env, [target]);
    let tokens = Vec::from_array(&env, [token]);
    let amounts = Vec::from_array(&env, [1000i128]);
    let memos = Vec::from_array(&env, [String::from_str(&env, "paused")]);
    let res = client.try_batch_fund_c_address(&source, &targets, &tokens, &amounts, &memos);
    assert_eq!(res, Err(Ok(BridgeError::ContractPaused)));
}
