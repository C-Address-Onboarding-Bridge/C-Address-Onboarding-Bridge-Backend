#![cfg(test)]

use soroban_sdk::{
    contract, contractimpl, contracttype, testutils::Address as _, Address, Env, IntoVal,
    MuxedAddress, String, Symbol, Vec,
};

use super::*;

// ---------------------------------------------------------------------------
// Test token — minimal SEP-41 compliant token.
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone)]
enum TK {
    Bal(Address),
}

#[contract]
struct TestToken;

#[contractimpl]
impl TestToken {
    pub fn transfer(env: Env, from: Address, to: MuxedAddress, amount: i128) {
        from.require_auth();
        let to_addr = to.address();
        let from_bal = env
            .storage()
            .persistent()
            .get::<TK, i128>(&TK::Bal(from.clone()))
            .unwrap_or(0);
        let to_bal = env
            .storage()
            .persistent()
            .get::<TK, i128>(&TK::Bal(to_addr.clone()))
            .unwrap_or(0);
        env.storage()
            .persistent()
            .set(&TK::Bal(from), &(from_bal - amount));
        env.storage()
            .persistent()
            .set(&TK::Bal(to_addr), &(to_bal + amount));
    }

    pub fn balance(env: Env, id: Address) -> i128 {
        env.storage()
            .persistent()
            .get::<TK, i128>(&TK::Bal(id))
            .unwrap_or(0)
    }

    pub fn mint(env: Env, to: Address, amount: i128) {
        let bal = env
            .storage()
            .persistent()
            .get::<TK, i128>(&TK::Bal(to.clone()))
            .unwrap_or(0);
        env.storage()
            .persistent()
            .set(&TK::Bal(to), &(bal + amount));
    }

    pub fn decimals(_env: Env) -> u32 {
        7
    }
    pub fn name(env: Env) -> String {
        String::from_str(&env, "TestToken")
    }
    pub fn symbol(env: Env) -> String {
        String::from_str(&env, "TEST")
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn setup_env() -> (Env, OnboardingBridgeClient<'static>) {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let id = env.register_contract(None, OnboardingBridge);
    let client = OnboardingBridgeClient::new(&env, &id);
    let env_cloned = env.clone();
    drop(env);
    (env_cloned, client)
}

// ---------------------------------------------------------------------------
// Input validation tests
// ---------------------------------------------------------------------------

#[test]
#[should_panic(expected = "amount must be positive")]
fn test_fund_c_address_zero_amount() {
    let (env, bridge) = setup_env();
    let admin = Address::generate(&env);
    let source = Address::generate(&env);
    let target = Address::generate(&env);
    let token_addr = Address::generate(&env);
    bridge.initialize(&admin, &100);
    let memo = String::from_str(&env, "test");
    bridge.fund_c_address(&source, &target, &token_addr, &0, &memo);
}

#[test]
#[should_panic(expected = "amount must be positive")]
fn test_fund_c_address_negative_amount() {
    let (env, bridge) = setup_env();
    let admin = Address::generate(&env);
    let source = Address::generate(&env);
    let target = Address::generate(&env);
    let token_addr = Address::generate(&env);
    bridge.initialize(&admin, &100);
    let memo = String::from_str(&env, "test");
    bridge.fund_c_address(&source, &target, &token_addr, &-1, &memo);
}

#[test]
#[should_panic(expected = "amount must be positive")]
fn test_route_from_exchange_zero_amount() {
    let (env, bridge) = setup_env();
    let admin = Address::generate(&env);
    let exchange = Address::generate(&env);
    let target = Address::generate(&env);
    let token_addr = Address::generate(&env);
    bridge.initialize(&admin, &100);
    let memo = String::from_str(&env, "test");
    bridge.route_from_exchange(&exchange, &target, &token_addr, &0, &memo);
}

// ---------------------------------------------------------------------------
// State & admin tests
// ---------------------------------------------------------------------------

#[test]
fn test_initialize() {
    let (env, bridge) = setup_env();
    let admin = Address::generate(&env);
    bridge.initialize(&admin, &30);
    assert_eq!(bridge.admin(), admin);
    assert_eq!(bridge.fee_bps(), 30);
    assert_eq!(bridge.version(), 1);
}

#[test]
#[should_panic(expected = "already initialized")]
fn test_double_initialize() {
    let (env, bridge) = setup_env();
    let admin = Address::generate(&env);
    bridge.initialize(&admin, &30);
    bridge.initialize(&admin, &50);
}

#[test]
fn test_set_fee() {
    let (env, bridge) = setup_env();
    let admin = Address::generate(&env);
    bridge.initialize(&admin, &30);
    assert_eq!(bridge.fee_bps(), 30);
    bridge.set_fee(&50);
    assert_eq!(bridge.fee_bps(), 50);
}

#[test]
fn test_initial_state() {
    let (env, bridge) = setup_env();
    let admin = Address::generate(&env);
    bridge.initialize(&admin, &100);
    assert_eq!(bridge.accumulated_fees(), 0);
    assert_eq!(bridge.version(), 1);
}

#[test]
fn test_set_fee_validation() {
    let (env, bridge) = setup_env();
    let admin = Address::generate(&env);
    bridge.initialize(&admin, &30);
    bridge.set_fee(&0);
    assert_eq!(bridge.fee_bps(), 0);
    bridge.set_fee(&10000);
    assert_eq!(bridge.fee_bps(), 10000);
}

// ---------------------------------------------------------------------------
// Fund & withdraw logic tests
// ---------------------------------------------------------------------------

#[test]
fn test_fund_c_address_tracks_fees() {
    let (env, bridge) = setup_env();
    let admin = Address::generate(&env);
    let source = Address::generate(&env);
    let target = Address::generate(&env);
    let token_addr = Address::generate(&env);
    bridge.initialize(&admin, &100);

    let memo = String::from_str(&env, "fund test");
    let fee = bridge.fund_c_address(&source, &target, &token_addr, &1000, &memo);

    assert_eq!(fee, 10);
    assert_eq!(bridge.accumulated_fees(), 10);
}

#[test]
fn test_fund_with_zero_fee() {
    let (env, bridge) = setup_env();
    let admin = Address::generate(&env);
    let source = Address::generate(&env);
    let target = Address::generate(&env);
    let token_addr = Address::generate(&env);
    bridge.initialize(&admin, &0);

    let memo = String::from_str(&env, "no fee");
    let fee = bridge.fund_c_address(&source, &target, &token_addr, &500, &memo);

    assert_eq!(fee, 0);
    assert_eq!(bridge.accumulated_fees(), 0);
}

#[test]
fn test_withdraw_fees() {
    let (env, bridge) = setup_env();
    let admin = Address::generate(&env);
    let source = Address::generate(&env);
    let target = Address::generate(&env);
    let token_addr = Address::generate(&env);
    bridge.initialize(&admin, &200);

    let memo = String::from_str(&env, "test");
    bridge.fund_c_address(&source, &target, &token_addr, &1000, &memo);
    assert_eq!(bridge.accumulated_fees(), 20);

    let withdrawn = bridge.withdraw_fees(&admin, &token_addr, &0);
    assert_eq!(withdrawn, 20);
    assert_eq!(bridge.accumulated_fees(), 0);
}

#[test]
fn test_withdraw_fees_partial() {
    let (env, bridge) = setup_env();
    let admin = Address::generate(&env);
    let source = Address::generate(&env);
    let target = Address::generate(&env);
    let token_addr = Address::generate(&env);
    bridge.initialize(&admin, &100);

    let memo = String::from_str(&env, "test");
    bridge.fund_c_address(&source, &target, &token_addr, &1000, &memo);
    assert_eq!(bridge.accumulated_fees(), 10);

    let withdrawn = bridge.withdraw_fees(&admin, &token_addr, &4);
    assert_eq!(withdrawn, 4);
    assert_eq!(bridge.accumulated_fees(), 6);
}

#[test]
#[should_panic(expected = "insufficient accumulated fees")]
fn test_withdraw_fees_excessive() {
    let (env, bridge) = setup_env();
    let admin = Address::generate(&env);
    let source = Address::generate(&env);
    let target = Address::generate(&env);
    let token_addr = Address::generate(&env);
    bridge.initialize(&admin, &100);

    let memo = String::from_str(&env, "test");
    bridge.fund_c_address(&source, &target, &token_addr, &1000, &memo);

    bridge.withdraw_fees(&admin, &token_addr, &999);
}

#[test]
fn test_route_from_exchange() {
    let (env, bridge) = setup_env();
    let admin = Address::generate(&env);
    let exchange = Address::generate(&env);
    let target = Address::generate(&env);
    let token_addr = Address::generate(&env);
    bridge.initialize(&admin, &50);

    let memo = String::from_str(&env, "cex test");
    let fee = bridge.route_from_exchange(&exchange, &target, &token_addr, &500, &memo);

    assert_eq!(fee, 2);
    assert_eq!(bridge.accumulated_fees(), 2);
}

#[test]
fn test_multiple_fund_accumulates_fees() {
    let (env, bridge) = setup_env();
    let admin = Address::generate(&env);
    let source = Address::generate(&env);
    let target = Address::generate(&env);
    let token_addr = Address::generate(&env);
    bridge.initialize(&admin, &100);

    let memo = String::from_str(&env, "tx1");
    bridge.fund_c_address(&source, &target, &token_addr, &1000, &memo);
    assert_eq!(bridge.accumulated_fees(), 10);

    let memo = String::from_str(&env, "tx2");
    bridge.fund_c_address(&source, &target, &token_addr, &2000, &memo);
    assert_eq!(bridge.accumulated_fees(), 30);

    let memo = String::from_str(&env, "tx3");
    bridge.fund_c_address(&source, &target, &token_addr, &3000, &memo);
    assert_eq!(bridge.accumulated_fees(), 60);
}

// ---------------------------------------------------------------------------
// Direct token transfer
// ---------------------------------------------------------------------------

#[test]
fn test_token_transfer_direct() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);

    let token_id = env.register_contract(None, TestToken);

    let _: () = env.invoke_contract(
        &token_id,
        &Symbol::new(&env, "mint"),
        Vec::from_array(&env, [alice.clone().into_val(&env), 500i128.into_val(&env)]),
    );

    let _: () = env.invoke_contract(
        &token_id,
        &Symbol::new(&env, "transfer"),
        Vec::from_array(
            &env,
            [
                alice.clone().into_val(&env),
                MuxedAddress::from(&bob).into_val(&env),
                200i128.into_val(&env),
            ],
        ),
    );

    let alice_bal: i128 = env.invoke_contract(
        &token_id,
        &Symbol::new(&env, "balance"),
        Vec::from_array(&env, [alice.clone().into_val(&env)]),
    );
    let bob_bal: i128 = env.invoke_contract(
        &token_id,
        &Symbol::new(&env, "balance"),
        Vec::from_array(&env, [bob.clone().into_val(&env)]),
    );

    assert_eq!(alice_bal, 300);
    assert_eq!(bob_bal, 200);
}

// ---------------------------------------------------------------------------
// Full integration scenario
// ---------------------------------------------------------------------------

#[test]
fn test_full_scenario() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    let admin = Address::generate(&env);
    let source = Address::generate(&env);
    let target = Address::generate(&env);
    let token_addr = Address::generate(&env);

    let bridge_id = env.register_contract(None, OnboardingBridge);
    let bridge = OnboardingBridgeClient::new(&env, &bridge_id);
    bridge.initialize(&admin, &100);

    let memo = String::from_str(&env, "full test");
    let fee = bridge.fund_c_address(&source, &target, &token_addr, &1000, &memo);
    assert_eq!(fee, 10);
    assert_eq!(bridge.accumulated_fees(), 10);

    let withdrawn = bridge.withdraw_fees(&admin, &token_addr, &0);
    assert_eq!(withdrawn, 10);
    assert_eq!(bridge.accumulated_fees(), 0);
}
