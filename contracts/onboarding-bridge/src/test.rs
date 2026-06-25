#![cfg(test)]

use soroban_sdk::{
    contract, contractimpl, contracttype, testutils::Address as _, testutils::Ledger as _,
    Address, Env, String,
};

use super::*;

// ---------------------------------------------------------------------------
// Minimal SEP-41 test token (supports real transfer)
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
    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        from.require_auth();
        let fb: i128 = env
            .storage()
            .persistent()
            .get::<TK, i128>(&TK::Bal(from.clone()))
            .unwrap_or(0);
        let tb: i128 = env
            .storage()
            .persistent()
            .get::<TK, i128>(&TK::Bal(to.clone()))
            .unwrap_or(0);
        env.storage()
            .persistent()
            .set(&TK::Bal(from), &(fb - amount));
        env.storage()
            .persistent()
            .set(&TK::Bal(to), &(tb + amount));
    }

    pub fn balance(env: Env, id: Address) -> i128 {
        env.storage()
            .persistent()
            .get::<TK, i128>(&TK::Bal(id))
            .unwrap_or(0)
    }

    pub fn mint(env: Env, to: Address, amount: i128) {
        let b: i128 = env
            .storage()
            .persistent()
            .get::<TK, i128>(&TK::Bal(to.clone()))
            .unwrap_or(0);
        env.storage().persistent().set(&TK::Bal(to), &(b + amount));
    }

    pub fn decimals(_env: Env) -> u32 { 7 }
    pub fn name(env: Env) -> String { String::from_str(&env, "TestToken") }
    pub fn symbol(env: Env) -> String { String::from_str(&env, "TEST") }
    pub fn allowance(_env: Env, _from: Address, _spender: Address) -> i128 { i128::MAX }
    pub fn approve(_env: Env, _from: Address, _spender: Address, _amount: i128, _exp: u32) {}
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

struct S {
    env: Env,
    bridge: OnboardingBridgeClient<'static>,
    token: TestTokenClient<'static>,
    admin: Address,
}

fn setup(fee_bps: u32, delay: u64) -> S {
    setup_full(fee_bps, delay, 1, i128::MAX)
}

fn setup_full(fee_bps: u32, delay: u64, min: i128, max: i128) -> S {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let bridge_id = env.register_contract(None, OnboardingBridge);
    let token_id = env.register_contract(None, TestToken);
    let bridge = OnboardingBridgeClient::new(&env, &bridge_id);
    let token = TestTokenClient::new(&env, &token_id);
    let admin = Address::generate(&env);
    bridge.initialize(&admin, &fee_bps, &delay, &min, &max);
    S { env, bridge, token, admin }
}

// ---------------------------------------------------------------------------
// Timelock tests (unchanged)
// ---------------------------------------------------------------------------

#[test]
fn test_initialize() {
    let s = setup(30, 0);
    assert_eq!(s.bridge.admin(), s.admin);
    assert_eq!(s.bridge.fee_bps(), 30);
    assert_eq!(s.bridge.version(), 2);
    assert!(!s.bridge.is_paused());
}

#[test]
#[should_panic(expected = "already initialized")]
fn test_double_initialize() {
    let s = setup(30, 0);
    s.bridge.initialize(&Address::generate(&s.env), &50, &0, &1, &i128::MAX);
}

#[test]
fn test_propose_cancel() {
    let s = setup(30, 0);
    let label = String::from_str(&s.env, "op1");
    let (hash, _) = s.bridge.propose_op(&label);
    s.bridge.cancel_op(&hash);
    assert!(s.bridge.pending_op(&hash).unwrap().cancelled);
}

#[test]
#[should_panic(expected = "timelock not elapsed")]
fn test_execute_before_delay() {
    let s = setup(30, 604800);
    let label = String::from_str(&s.env, "fee_op");
    s.bridge.propose_set_fee(&label);
    s.bridge.execute_set_fee(&50, &label);
}

#[test]
fn test_execute_after_delay() {
    let s = setup(30, 100);
    let label = String::from_str(&s.env, "fee_op");
    s.bridge.propose_set_fee(&label);
    s.env.ledger().set_timestamp(s.env.ledger().timestamp() + 200);
    s.bridge.execute_set_fee(&50, &label);
    assert_eq!(s.bridge.fee_bps(), 50);
}

#[test]
fn test_pause_unpause() {
    let s = setup(0, 0);
    s.bridge.pause();
    assert!(s.bridge.is_paused());
    s.bridge.unpause();
    assert!(!s.bridge.is_paused());
}

// ---------------------------------------------------------------------------
// SAC token transfer tests
// ---------------------------------------------------------------------------

#[test]
fn test_fund_transfers_tokens_and_tracks_fees() {
    let s = setup(100, 0); // 1% fee
    let source = Address::generate(&s.env);
    let target = Address::generate(&s.env);
    s.token.mint(&source, &1000);

    let fee = s.bridge.fund_c_address(
        &source, &target, &s.token.address, &1000,
        &String::from_str(&s.env, "test"),
    );
    assert_eq!(fee, 10);
    assert_eq!(s.token.balance(&source), 0);
    assert_eq!(s.token.balance(&target), 990);
    assert_eq!(s.bridge.accumulated_fees(&s.token.address), 10);
}

#[test]
fn test_fund_zero_fee() {
    let s = setup(0, 0);
    let source = Address::generate(&s.env);
    let target = Address::generate(&s.env);
    s.token.mint(&source, &500);
    let fee = s.bridge.fund_c_address(
        &source, &target, &s.token.address, &500,
        &String::from_str(&s.env, "no fee"),
    );
    assert_eq!(fee, 0);
    assert_eq!(s.token.balance(&target), 500);
    assert_eq!(s.bridge.accumulated_fees(&s.token.address), 0);
}

#[test]
fn test_withdraw_all_fees() {
    let s = setup(200, 0); // 2%
    let source = Address::generate(&s.env);
    let target = Address::generate(&s.env);
    s.token.mint(&source, &1000);
    s.bridge.fund_c_address(
        &source, &target, &s.token.address, &1000,
        &String::from_str(&s.env, "test"),
    );
    assert_eq!(s.bridge.accumulated_fees(&s.token.address), 20);

    let withdrawn = s.bridge.withdraw_fees(&s.admin, &s.token.address, &0);
    assert_eq!(withdrawn, 20);
    assert_eq!(s.bridge.accumulated_fees(&s.token.address), 0);
    assert_eq!(s.token.balance(&s.admin), 20);
}

#[test]
fn test_withdraw_partial_fees() {
    let s = setup(100, 0);
    let source = Address::generate(&s.env);
    let target = Address::generate(&s.env);
    s.token.mint(&source, &1000);
    s.bridge.fund_c_address(
        &source, &target, &s.token.address, &1000,
        &String::from_str(&s.env, "test"),
    );
    let withdrawn = s.bridge.withdraw_fees(&s.admin, &s.token.address, &4);
    assert_eq!(withdrawn, 4);
    assert_eq!(s.bridge.accumulated_fees(&s.token.address), 6);
}

#[test]
#[should_panic(expected = "insufficient accumulated fees")]
fn test_withdraw_excess() {
    let s = setup(100, 0);
    let source = Address::generate(&s.env);
    let target = Address::generate(&s.env);
    s.token.mint(&source, &1000);
    s.bridge.fund_c_address(
        &source, &target, &s.token.address, &1000,
        &String::from_str(&s.env, "test"),
    );
    s.bridge.withdraw_fees(&s.admin, &s.token.address, &999);
}

#[test]
fn test_route_from_exchange() {
    let s = setup(50, 0);
    let exchange = Address::generate(&s.env);
    let target = Address::generate(&s.env);
    s.token.mint(&exchange, &500);
    let fee = s.bridge.route_from_exchange(
        &exchange, &target, &s.token.address, &500,
        &String::from_str(&s.env, "cex"),
    );
    assert_eq!(fee, 2);
    assert_eq!(s.token.balance(&target), 498);
}

#[test]
fn test_multiple_fund_accumulates_fees() {
    let s = setup(100, 0);
    let source = Address::generate(&s.env);
    let target = Address::generate(&s.env);
    s.token.mint(&source, &6000);
    let m = |l: &str| String::from_str(&s.env, l);
    s.bridge.fund_c_address(&source, &target, &s.token.address, &1000, &m("t1"));
    s.bridge.fund_c_address(&source, &target, &s.token.address, &2000, &m("t2"));
    s.bridge.fund_c_address(&source, &target, &s.token.address, &3000, &m("t3"));
    assert_eq!(s.bridge.accumulated_fees(&s.token.address), 60);
}

#[test]
#[should_panic(expected = "contract is paused")]
fn test_fund_while_paused() {
    let s = setup(0, 0);
    let source = Address::generate(&s.env);
    let target = Address::generate(&s.env);
    s.token.mint(&source, &1000);
    s.bridge.pause();
    s.bridge.fund_c_address(
        &source, &target, &s.token.address, &500,
        &String::from_str(&s.env, "test"),
    );
}

// ---------------------------------------------------------------------------
// Amount constraint tests
// ---------------------------------------------------------------------------

#[test]
fn test_min_max_getters() {
    let s = setup_full(0, 0, 100, 5000);
    assert_eq!(s.bridge.min_amount(), 100);
    assert_eq!(s.bridge.max_amount(), 5000);
}

#[test]
#[should_panic(expected = "amount below minimum")]
fn test_below_min() {
    let s = setup_full(0, 0, 100, i128::MAX);
    let source = Address::generate(&s.env);
    let target = Address::generate(&s.env);
    s.token.mint(&source, &50);
    s.bridge.fund_c_address(&source, &target, &s.token.address, &50, &String::from_str(&s.env, "t"));
}

#[test]
#[should_panic(expected = "amount above maximum")]
fn test_above_max() {
    let s = setup_full(0, 0, 1, 100);
    let source = Address::generate(&s.env);
    let target = Address::generate(&s.env);
    s.token.mint(&source, &200);
    s.bridge.fund_c_address(&source, &target, &s.token.address, &200, &String::from_str(&s.env, "t"));
}

#[test]
fn test_at_min_and_max_bounds() {
    let s = setup_full(0, 0, 100, 1000);
    let source = Address::generate(&s.env);
    let target = Address::generate(&s.env);
    s.token.mint(&source, &1100);
    let m = |l: &str| String::from_str(&s.env, l);
    s.bridge.fund_c_address(&source, &target, &s.token.address, &100, &m("min"));
    s.bridge.fund_c_address(&source, &target, &s.token.address, &1000, &m("max"));
    assert_eq!(s.token.balance(&target), 1100);
}

#[test]
fn test_execute_set_min_after_timelock() {
    let s = setup_full(0, 100, 1, i128::MAX);
    let label = String::from_str(&s.env, "set_min");
    s.bridge.propose_set_min(&label);
    s.env.ledger().set_timestamp(s.env.ledger().timestamp() + 200);
    s.bridge.execute_set_min(&50, &label);
    assert_eq!(s.bridge.min_amount(), 50);
}

#[test]
fn test_execute_set_max_after_timelock() {
    let s = setup_full(0, 100, 1, i128::MAX);
    let label = String::from_str(&s.env, "set_max");
    s.bridge.propose_set_max(&label);
    s.env.ledger().set_timestamp(s.env.ledger().timestamp() + 200);
    s.bridge.execute_set_max(&5000, &label);
    assert_eq!(s.bridge.max_amount(), 5000);
}
