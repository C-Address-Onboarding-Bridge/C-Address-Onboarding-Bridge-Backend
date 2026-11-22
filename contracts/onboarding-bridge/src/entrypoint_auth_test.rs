#![cfg(test)]

use soroban_sdk::{testutils::Address as _, Address, Env, String, Vec};

use super::*;

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
