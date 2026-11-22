#![cfg(test)]

extern crate std;

use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::StellarAssetClient,
    Address, Env, String, Vec,
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

// #1085: UniqueFunder entries are TTL-extended so returning users can fund.

#[test]
fn test_returning_funder_succeeds_after_default_ttl_elapsed() {
    let env = Env::default();
    let bridge = new_bridge(&env);
    let admins = distinct_admins(&env, 1);
    bridge.initialize(&admins, &1, &100, &1000, &1, &i128::MAX);

    let issuer = Address::generate(&env);
    let token = env.register_stellar_asset_contract_v2(issuer).address();
    let source = Address::generate(&env);
    let target = Address::generate(&env);
    let memo = String::from_str(&env, "m");
    StellarAssetClient::new(&env, &token).mint(&source, &10_000);

    bridge.fund_c_address(&source, &target, &token, &1000, &memo);
    assert_eq!(bridge.get_stats().unique_funder_count, 1);

    // Move well past the network default minimum persistent TTL (4096).
    env.ledger()
        .set_sequence_number(env.ledger().sequence() + 10_000);

    bridge.fund_c_address(&source, &target, &token, &1000, &memo);
    assert_eq!(bridge.get_stats().unique_funder_count, 1);
}

// #1084: accounting actions respect the execution delay.

#[test]
fn test_rebate_tier_and_token_rate_respect_execution_delay() {
    let env = Env::default();
    let bridge = new_bridge(&env);
    let admins = distinct_admins(&env, 1);
    bridge.initialize(&admins, &1, &100, &1000, &1, &i128::MAX);
    let admin = admins.get_unchecked(0);
    let token = Address::generate(&env);

    let p1 = bridge.propose(&admin, &ProposalAction::SetRebateTier(0, 1000, 100), &1000);
    let p2 = bridge.propose(&admin, &ProposalAction::SetFeeTokenRate(token, 5000), &1000);

    assert_eq!(bridge.try_execute(&p1), Err(Ok(BridgeError::ExecutionTooSoon)));
    assert_eq!(bridge.try_execute(&p2), Err(Ok(BridgeError::ExecutionTooSoon)));

    env.ledger()
        .set_sequence_number(env.ledger().sequence() + MIN_EXEC_DELAY);
    bridge.execute(&p1);
    bridge.execute(&p2);
}

// #1082: pruning is permissionless and skips over active proposals.

#[test]
fn test_prune_skips_active_proposal_and_prunes_later_terminal_ones() {
    let env = Env::default();
    let bridge = new_bridge(&env);
    let admins = distinct_admins(&env, 2);
    bridge.initialize(&admins, &2, &100, &1000, &1, &i128::MAX);
    let a = admins.get_unchecked(0);
    let b = admins.get_unchecked(1);

    // [active (long expiry), executed, expired]
    let active = bridge.propose(&a, &ProposalAction::SetFee(150), &100_000);
    let executed = bridge.propose(&a, &ProposalAction::SetFee(200), &100_000);
    bridge.approve(&b, &executed);
    let expired = bridge.propose(&a, &ProposalAction::SetFee(300), &10);
    env.ledger()
        .set_sequence_number(env.ledger().sequence() + MIN_EXEC_DELAY + 20);
    bridge.execute(&executed);

    // The call takes no caller and requires no auth, so any party may prune.
    let pruned = bridge.prune_proposals(&10);
    assert_eq!(pruned, 2);

    let exists = |id: u32| {
        env.as_contract(&bridge.address, || {
            env.storage().persistent().has(&DataKey::Proposal(id))
        })
    };
    assert!(exists(active));
    assert!(!exists(executed));
    assert!(!exists(expired));
}
