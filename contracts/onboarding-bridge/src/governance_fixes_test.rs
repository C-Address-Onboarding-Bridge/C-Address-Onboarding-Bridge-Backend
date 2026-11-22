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

/// #1080: get_proposal reads the persistent entry written by propose.
#[test]
fn test_get_proposal_reads_persistent_storage() {
    let (_env, bridge, admins) = setup(2, 2, 100);
    let pid = bridge.propose(&admins.get_unchecked(0), &ProposalAction::SetFee(200), &1000);
    let p = bridge.get_proposal(&pid);
    assert_eq!(p.id, pid);
    assert_eq!(p.approval_count, 1);
}

/// #1079: fees of a non-whitelisted token are withdrawable, and amount = 0
/// withdraws only that token's own balance.
#[test]
fn test_withdraw_fees_zero_amount_uses_per_token_balance() {
    let (env, bridge, admins) = setup(2, 2, 100);
    let token_a = env.register_contract(None, FixToken);
    let token_b = env.register_contract(None, FixToken);
    let source = Address::generate(&env);
    let target = Address::generate(&env);
    let memo = String::from_str(&env, "m");
    FixTokenClient::new(&env, &token_a).mint(&source, &10_000);
    FixTokenClient::new(&env, &token_b).mint(&source, &10_000);
    bridge.fund_c_address(&source, &target, &token_a, &5000, &memo); // fee 50
    bridge.fund_c_address(&source, &target, &token_b, &3000, &memo); // fee 30

    let to = Address::generate(&env);
    let pid = bridge.propose(
        &admins.get_unchecked(0),
        &ProposalAction::WithdrawFees(to.clone(), token_a.clone(), 0),
        &1000,
    );
    bridge.approve(&admins.get_unchecked(1), &pid);
    advance(&env, MIN_EXEC_DELAY);
    assert_eq!(bridge.execute(&pid), 50);
    assert_eq!(FixTokenClient::new(&env, &token_a).balance(&to), 50);
    assert_eq!(bridge.accumulated_fees_for_token(&token_a), 0);
    assert_eq!(bridge.accumulated_fees_for_token(&token_b), 30);
}

/// #1081: an approval from an admin removed by RotateAdmins no longer counts.
#[test]
fn test_removed_admin_approval_not_counted_after_rotation() {
    let (env, bridge, admins) = setup(2, 2, 100);
    let removed = admins.get_unchecked(1);
    let pending = bridge.propose(&admins.get_unchecked(0), &ProposalAction::SetFee(200), &1000);
    bridge.approve(&removed, &pending);

    let mut new_admins: Vec<Address> = Vec::new(&env);
    new_admins.push_back(admins.get_unchecked(0));
    new_admins.push_back(Address::generate(&env));
    let rotation = bridge.propose(
        &admins.get_unchecked(0),
        &ProposalAction::RotateAdmins(new_admins.clone()),
        &1000,
    );
    bridge.approve(&removed, &rotation);
    advance(&env, MIN_EXEC_DELAY);
    bridge.execute(&rotation);

    assert_eq!(
        bridge.try_execute(&pending),
        Err(Ok(BridgeError::InsufficientApprovals))
    );

    // A current admin's approval makes the proposal executable again.
    bridge.approve(&new_admins.get_unchecked(1), &pending);
    bridge.execute(&pending);
}
