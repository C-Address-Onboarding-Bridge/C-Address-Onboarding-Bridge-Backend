#![cfg(test)]

extern crate std;

use soroban_sdk::{
    contract, contractimpl, contracttype,
    testutils::{Address as _, Ledger},
    Address, Env, String, Vec,
};

use super::*;

#[contracttype]
#[derive(Clone)]
enum Bal {
    Of(Address),
}

#[contract]
struct FixToken;

#[contractimpl]
impl FixToken {
    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        from.require_auth();
        let fb = Self::balance(env.clone(), from.clone());
        assert!(fb >= amount, "insufficient balance");
        let tb = Self::balance(env.clone(), to.clone());
        env.storage().persistent().set(&Bal::Of(from), &(fb - amount));
        env.storage().persistent().set(&Bal::Of(to), &(tb + amount));
    }

    pub fn balance(env: Env, id: Address) -> i128 {
        env.storage().persistent().get(&Bal::Of(id)).unwrap_or(0)
    }

    pub fn mint(env: Env, to: Address, amount: i128) {
        let b = Self::balance(env.clone(), to.clone());
        env.storage().persistent().set(&Bal::Of(to), &(b + amount));
    }
}

fn setup(
    admin_count: u32,
    threshold: u32,
    fee_bps: u32,
) -> (Env, OnboardingBridgeClient<'static>, Vec<Address>) {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let id = env.register_contract(None, OnboardingBridge);
    let bridge = OnboardingBridgeClient::new(&env, &id);
    let bridge: OnboardingBridgeClient<'static> = unsafe { core::mem::transmute(bridge) };
    let mut admins: Vec<Address> = Vec::new(&env);
    for _ in 0..admin_count {
        admins.push_back(Address::generate(&env));
    }
    bridge.initialize(&admins, &threshold, &fee_bps, &10000, &1, &i128::MAX);
    (env, bridge, admins)
}

fn advance(env: &Env, n: u32) {
    env.ledger()
        .set_sequence_number(env.ledger().sequence() + n);
}

/// #1078: the guard must be released after a successful route_from_exchange.
#[test]
fn test_route_from_exchange_clears_reentrancy_guard() {
    let (env, bridge, _) = setup(1, 1, 100);
    let token = env.register_contract(None, FixToken);
    let exchange = Address::generate(&env);
    let target = Address::generate(&env);
    FixTokenClient::new(&env, &token).mint(&exchange, &10_000);
    let memo = String::from_str(&env, "cex");
    bridge.route_from_exchange(&exchange, &target, &token, &1000, &memo);
    bridge.route_from_exchange(&exchange, &target, &token, &1000, &memo);
    env.as_contract(&bridge.address, || {
        assert!(!env.storage().temporary().has(&DataKey::ReentrancyGuard));
    });
}

