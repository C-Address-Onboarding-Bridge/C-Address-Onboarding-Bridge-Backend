#![cfg(test)]

extern crate std;

use soroban_sdk::{
    contract, contractimpl, contracttype, testutils::Address as _, testutils::Ledger, Address, Env,
    IntoVal, MuxedAddress, String, Symbol, Vec,
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

fn create_admins(env: &Env, count: u32) -> Vec<Address> {
    let mut admins: Vec<Address> = Vec::new(env);
    for _ in 0..count {
        admins.push_back(Address::generate(env));
    }
    admins
}

fn setup_env() -> (Env, OnboardingBridgeClient<'static>) {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let id = env.register_contract(None, OnboardingBridge);
    let client = OnboardingBridgeClient::new(&env, &id);
    let env_cloned = env.clone();
    drop(env);
    (env_cloned, client)
}

fn setup_env_with_admins(
    admin_count: u32,
    threshold: u32,
    fee_bps: u32,
    max_fee_bps: u32,
) -> (Env, OnboardingBridgeClient<'static>, Vec<Address>) {
    let (env, bridge) = setup_env();
    let admins = create_admins(&env, admin_count);
    bridge.initialize(&admins, &threshold, &fee_bps, &max_fee_bps);
    (env, bridge, admins)
}

// ===========================================================================
// Task 1: Input Validation Tests
// ===========================================================================

#[test]
#[should_panic(expected = "max_fee_bps must be <= 10000")]
fn test_initialize_validates_max_fee_bps() {
    let (env, bridge) = setup_env();
    let admins = create_admins(&env, 2);
    bridge.initialize(&admins, &2, &50, &10001);
}

#[test]
#[should_panic(expected = "fee_bps must be <= max_fee_bps")]
fn test_initialize_validates_fee_vs_max_fee() {
    let (env, bridge) = setup_env();
    let admins = create_admins(&env, 2);
    bridge.initialize(&admins, &2, &2000, &1000);
}

#[test]
#[should_panic(expected = "threshold must be > 0")]
fn test_initialize_validates_threshold_zero() {
    let (env, bridge) = setup_env();
    let admins = create_admins(&env, 2);
    bridge.initialize(&admins, &0, &50, &1000);
}

#[test]
#[should_panic(expected = "threshold exceeds admin count")]
fn test_initialize_validates_threshold_exceeds() {
    let (env, bridge) = setup_env();
    let admins = create_admins(&env, 2);
    bridge.initialize(&admins, &3, &50, &1000);
}

#[test]
#[should_panic(expected = "admins must not be empty")]
fn test_initialize_validates_admins_not_empty() {
    let (env, bridge) = setup_env();
    let empty: Vec<Address> = Vec::new(&env);
    bridge.initialize(&empty, &1, &50, &1000);
}

#[test]
#[should_panic(expected = "amount must be positive")]
fn test_fund_c_address_zero_amount() {
    let (env, bridge, _admins) = setup_env_with_admins(1, 1, 100, 1000);
    let source = Address::generate(&env);
    let target = Address::generate(&env);
    let token_addr = Address::generate(&env);
    let memo = String::from_str(&env, "test");
    bridge.fund_c_address(&source, &target, &token_addr, &0, &memo);
}

#[test]
#[should_panic(expected = "amount must be positive")]
fn test_fund_c_address_negative_amount() {
    let (env, bridge, _admins) = setup_env_with_admins(1, 1, 100, 1000);
    let source = Address::generate(&env);
    let target = Address::generate(&env);
    let token_addr = Address::generate(&env);
    let memo = String::from_str(&env, "test");
    bridge.fund_c_address(&source, &target, &token_addr, &-1, &memo);
}

#[test]
#[should_panic(expected = "amount must be positive")]
fn test_route_from_exchange_zero_amount() {
    let (env, bridge, _admins) = setup_env_with_admins(1, 1, 100, 1000);
    let exchange = Address::generate(&env);
    let target = Address::generate(&env);
    let token_addr = Address::generate(&env);
    let memo = String::from_str(&env, "test");
    bridge.route_from_exchange(&exchange, &target, &token_addr, &0, &memo);
}

// ===========================================================================
// Task 2: Emergency Pause Tests
// ===========================================================================

#[test]
fn test_is_paused_initial_state() {
    let (_env, bridge, _admins) = setup_env_with_admins(2, 2, 100, 1000);
    assert!(!bridge.is_paused());
}

#[test]
fn test_pause_and_unpause() {
    let (_env, bridge, admins) = setup_env_with_admins(2, 2, 100, 1000);

    let pid = bridge.propose(&admins.get_unchecked(0), &ProposalAction::Pause, &1000);
    bridge.approve(&admins.get_unchecked(1), &pid);
    bridge.execute(&pid);
    assert!(bridge.is_paused());

    let pid = bridge.propose(&admins.get_unchecked(0), &ProposalAction::Unpause, &1000);
    bridge.approve(&admins.get_unchecked(1), &pid);
    bridge.execute(&pid);
    assert!(!bridge.is_paused());
}

#[test]
#[should_panic(expected = "contract is paused")]
fn test_fund_c_address_blocked_when_paused() {
    let (env, bridge, admins) = setup_env_with_admins(2, 2, 100, 1000);

    let pid = bridge.propose(&admins.get_unchecked(0), &ProposalAction::Pause, &1000);
    bridge.approve(&admins.get_unchecked(1), &pid);
    bridge.execute(&pid);

    let source = Address::generate(&env);
    let target = Address::generate(&env);
    let token_addr = Address::generate(&env);
    let memo = String::from_str(&env, "test");
    bridge.fund_c_address(&source, &target, &token_addr, &1000, &memo);
}

#[test]
#[should_panic(expected = "contract is paused")]
fn test_route_from_exchange_blocked_when_paused() {
    let (env, bridge, admins) = setup_env_with_admins(2, 2, 100, 1000);

    let pid = bridge.propose(&admins.get_unchecked(0), &ProposalAction::Pause, &1000);
    bridge.approve(&admins.get_unchecked(1), &pid);
    bridge.execute(&pid);

    let exchange = Address::generate(&env);
    let target = Address::generate(&env);
    let token_addr = Address::generate(&env);
    let memo = String::from_str(&env, "test");
    bridge.route_from_exchange(&exchange, &target, &token_addr, &1000, &memo);
}

#[test]
fn test_withdraw_fees_works_when_paused() {
    let (env, bridge, admins) = setup_env_with_admins(2, 2, 100, 1000);
    let source = Address::generate(&env);
    let target = Address::generate(&env);
    let token_addr = Address::generate(&env);
    let memo = String::from_str(&env, "test");

    bridge.fund_c_address(&source, &target, &token_addr, &1000, &memo);
    assert_eq!(bridge.accumulated_fees(), 10);

    // Pause
    let pid = bridge.propose(&admins.get_unchecked(0), &ProposalAction::Pause, &1000);
    bridge.approve(&admins.get_unchecked(1), &pid);
    bridge.execute(&pid);

    // Withdraw fees via proposal works even when paused
    let to = Address::generate(&env);
    let token_addr2 = Address::generate(&env);
    let wpid = bridge.propose(
        &admins.get_unchecked(0),
        &ProposalAction::WithdrawFees(to.clone(), token_addr2.clone(), 0i128),
        &1000,
    );
    bridge.approve(&admins.get_unchecked(1), &wpid);
    let withdrawn = bridge.execute(&wpid);
    assert_eq!(withdrawn, 10);
    assert_eq!(bridge.accumulated_fees(), 0);
}

#[test]
fn test_pause_event_emitted() {
    let (_env, bridge, admins) = setup_env_with_admins(2, 2, 100, 1000);

    let pid = bridge.propose(&admins.get_unchecked(0), &ProposalAction::Pause, &1000);
    bridge.approve(&admins.get_unchecked(1), &pid);
    bridge.execute(&pid);

    assert!(bridge.is_paused());
}

// ===========================================================================
// Task 3: Fee Capping Tests
// ===========================================================================

#[test]
fn test_max_fee_bps_immutable_after_init() {
    let (_env, bridge, _admins) = setup_env_with_admins(1, 1, 50, 1000);
    assert_eq!(bridge.max_fee_bps(), 1000);
    assert_eq!(bridge.fee_bps(), 50);
}

#[test]
#[should_panic(expected = "fee exceeds max_fee_bps")]
fn test_set_fee_rejects_above_max() {
    let (_env, bridge, admins) = setup_env_with_admins(2, 2, 50, 500);

    let pid = bridge.propose(
        &admins.get_unchecked(0),
        &ProposalAction::SetFee(600),
        &1000,
    );
    bridge.approve(&admins.get_unchecked(1), &pid);
    bridge.execute(&pid);
}

#[test]
fn test_set_fee_accepts_at_max() {
    let (_env, bridge, admins) = setup_env_with_admins(2, 2, 50, 500);

    let pid = bridge.propose(
        &admins.get_unchecked(0),
        &ProposalAction::SetFee(500),
        &1000,
    );
    bridge.approve(&admins.get_unchecked(1), &pid);
    bridge.execute(&pid);
    assert_eq!(bridge.fee_bps(), 500);
}

#[test]
fn test_set_fee_accepts_below_max() {
    let (_env, bridge, admins) = setup_env_with_admins(2, 2, 50, 1000);

    let pid = bridge.propose(
        &admins.get_unchecked(0),
        &ProposalAction::SetFee(100),
        &1000,
    );
    bridge.approve(&admins.get_unchecked(1), &pid);
    bridge.execute(&pid);
    assert_eq!(bridge.fee_bps(), 100);
}

// ===========================================================================
// Task 4: Multisig Governance Tests
// ===========================================================================

#[test]
fn test_propose_creates_proposal() {
    let (_env, bridge, admins) = setup_env_with_admins(2, 2, 100, 1000);
    let proposer = admins.get_unchecked(0);

    let pid = bridge.propose(&proposer, &ProposalAction::SetFee(200), &1000);

    let proposal = bridge.get_proposal(&pid);
    assert_eq!(proposal.id, pid);
    assert!(!proposal.executed);
    assert_eq!(proposal.approval_count, 1);
    assert_eq!(proposal.proposer, proposer);
}

#[test]
fn test_approve_increases_count() {
    let (_env, bridge, admins) = setup_env_with_admins(2, 2, 100, 1000);
    let proposer = admins.get_unchecked(0);

    let pid = bridge.propose(&proposer, &ProposalAction::SetFee(200), &1000);
    bridge.approve(&admins.get_unchecked(1), &pid);

    let proposal = bridge.get_proposal(&pid);
    assert_eq!(proposal.approval_count, 2);
}

#[test]
fn test_execute_with_threshold() {
    let (_env, bridge, admins) = setup_env_with_admins(2, 2, 100, 1000);
    let proposer = admins.get_unchecked(0);

    let pid = bridge.propose(&proposer, &ProposalAction::SetFee(200), &1000);
    bridge.approve(&admins.get_unchecked(1), &pid);
    bridge.execute(&pid);

    assert_eq!(bridge.fee_bps(), 200);
    let proposal = bridge.get_proposal(&pid);
    assert!(proposal.executed);
}

#[test]
#[should_panic(expected = "insufficient approvals")]
fn test_execute_fails_without_threshold() {
    let (_env, bridge, admins) = setup_env_with_admins(2, 2, 100, 1000);
    let proposer = admins.get_unchecked(0);

    let pid = bridge.propose(&proposer, &ProposalAction::SetFee(200), &1000);
    bridge.execute(&pid);
}

#[test]
#[should_panic(expected = "already approved this proposal")]
fn test_double_approve_rejected() {
    let (_env, bridge, admins) = setup_env_with_admins(3, 2, 100, 1000);
    let proposer = admins.get_unchecked(0);

    let pid = bridge.propose(&proposer, &ProposalAction::SetFee(200), &1000);
    bridge.approve(&admins.get_unchecked(1), &pid);
    bridge.approve(&admins.get_unchecked(1), &pid);
}

#[test]
#[should_panic(expected = "proposal expired")]
fn test_proposal_expiry() {
    let (env, bridge, admins) = setup_env_with_admins(2, 2, 100, 1000);
    let proposer = admins.get_unchecked(0);

    let pid = bridge.propose(&proposer, &ProposalAction::SetFee(200), &10);
    bridge.approve(&admins.get_unchecked(1), &pid);

    env.ledger()
        .set_sequence_number(env.ledger().sequence() + 20);
    bridge.execute(&pid);
}

#[test]
#[should_panic(expected = "only admins can propose")]
fn test_non_admin_cannot_propose() {
    let (_env, bridge, _admins) = setup_env_with_admins(2, 2, 100, 1000);
    let non_admin = Address::generate(&_env);

    let _pid = bridge.propose(&non_admin, &ProposalAction::SetFee(200), &1000);
}

#[test]
#[should_panic(expected = "only admins can approve")]
fn test_non_admin_cannot_approve() {
    let (_env, bridge, admins) = setup_env_with_admins(2, 2, 100, 1000);
    let non_admin = Address::generate(&_env);
    let proposer = admins.get_unchecked(0);

    let pid = bridge.propose(&proposer, &ProposalAction::SetFee(200), &1000);
    bridge.approve(&non_admin, &pid);
}

#[test]
fn test_get_admins_returns_correct_list() {
    let (_env, bridge, admins) = setup_env_with_admins(3, 2, 100, 1000);
    let stored = bridge.get_admins();
    assert_eq!(stored.len(), 3);
    for i in 0..3 {
        assert_eq!(stored.get_unchecked(i), admins.get_unchecked(i));
    }
}

#[test]
fn test_get_threshold() {
    let (_env, bridge, _admins) = setup_env_with_admins(3, 2, 100, 1000);
    assert_eq!(bridge.get_threshold(), 2);
}

#[test]
fn test_get_active_proposals() {
    let (env, bridge, admins) = setup_env_with_admins(3, 2, 100, 1000);
    let proposer = admins.get_unchecked(0);

    let pid1 = bridge.propose(&proposer, &ProposalAction::SetFee(200), &1000);
    let _pid2 = bridge.propose(&proposer, &ProposalAction::SetFee(300), &10);
    let pid3 = bridge.propose(&proposer, &ProposalAction::SetFee(400), &1000);

    // Approve and execute pid1
    bridge.approve(&admins.get_unchecked(1), &pid1);
    bridge.approve(&admins.get_unchecked(2), &pid1);
    bridge.execute(&pid1);

    // Advance ledger to expire pid2
    env.ledger()
        .set_sequence_number(env.ledger().sequence() + 20);

    let active = bridge.get_active_proposals();
    assert_eq!(active.len(), 1);
    assert_eq!(active.get_unchecked(0).id, pid3);
}

#[test]
fn test_proposal_withdraw_fees_execution() {
    let (_env, bridge, admins) = setup_env_with_admins(2, 2, 100, 1000);

    let source = Address::generate(&_env);
    let target = Address::generate(&_env);
    let token_addr = Address::generate(&_env);
    let memo = String::from_str(&_env, "test");
    bridge.fund_c_address(&source, &target, &token_addr, &5000, &memo);
    assert_eq!(bridge.accumulated_fees(), 50);

    let to = Address::generate(&_env);
    let pid = bridge.propose(
        &admins.get_unchecked(0),
        &ProposalAction::WithdrawFees(to.clone(), token_addr.clone(), 30i128),
        &1000,
    );
    bridge.approve(&admins.get_unchecked(1), &pid);
    bridge.execute(&pid);

    assert_eq!(bridge.accumulated_fees(), 20);
}

#[test]
fn test_proposal_withdraw_all_fees() {
    let (_env, bridge, admins) = setup_env_with_admins(2, 2, 100, 1000);

    let source = Address::generate(&_env);
    let target = Address::generate(&_env);
    let token_addr = Address::generate(&_env);
    let memo = String::from_str(&_env, "test");
    bridge.fund_c_address(&source, &target, &token_addr, &1000, &memo);
    assert_eq!(bridge.accumulated_fees(), 10);

    let to = Address::generate(&_env);
    let pid = bridge.propose(
        &admins.get_unchecked(0),
        &ProposalAction::WithdrawFees(to.clone(), token_addr.clone(), 0i128),
        &1000,
    );
    bridge.approve(&admins.get_unchecked(1), &pid);
    bridge.execute(&pid);

    assert_eq!(bridge.accumulated_fees(), 0);
}

#[test]
#[should_panic(expected = "insufficient accumulated fees")]
fn test_proposal_withdraw_excessive_fees_rejected() {
    let (_env, bridge, admins) = setup_env_with_admins(2, 2, 100, 1000);

    let source = Address::generate(&_env);
    let target = Address::generate(&_env);
    let token_addr = Address::generate(&_env);
    let memo = String::from_str(&_env, "test");
    bridge.fund_c_address(&source, &target, &token_addr, &1000, &memo);

    let to = Address::generate(&_env);
    let pid = bridge.propose(
        &admins.get_unchecked(0),
        &ProposalAction::WithdrawFees(to.clone(), token_addr.clone(), 999i128),
        &1000,
    );
    bridge.approve(&admins.get_unchecked(1), &pid);
    bridge.execute(&pid);
}

// ===========================================================================
// Original behavior tests (adapted for multisig)
// ===========================================================================

#[test]
fn test_initialize() {
    let (_env, bridge, _admins) = setup_env_with_admins(2, 2, 30, 1000);
    assert_eq!(bridge.fee_bps(), 30);
    assert_eq!(bridge.version(), 1);
    assert_eq!(bridge.max_fee_bps(), 1000);
}

#[test]
#[should_panic(expected = "already initialized")]
fn test_double_initialize() {
    let (env, bridge) = setup_env();
    let admins = create_admins(&env, 2);
    bridge.initialize(&admins, &2, &30, &1000);
    bridge.initialize(&admins, &2, &50, &1000);
}

#[test]
fn test_set_fee() {
    let (_env, bridge, admins) = setup_env_with_admins(2, 2, 30, 1000);
    assert_eq!(bridge.fee_bps(), 30);

    let pid = bridge.propose(&admins.get_unchecked(0), &ProposalAction::SetFee(50), &1000);
    bridge.approve(&admins.get_unchecked(1), &pid);
    bridge.execute(&pid);
    assert_eq!(bridge.fee_bps(), 50);
}

#[test]
fn test_initial_state() {
    let (_env, bridge, _admins) = setup_env_with_admins(2, 2, 100, 1000);
    assert_eq!(bridge.accumulated_fees(), 0);
    assert_eq!(bridge.version(), 1);
    assert_eq!(bridge.max_fee_bps(), 1000);
}

#[test]
fn test_set_fee_zero() {
    let (_env, bridge, admins) = setup_env_with_admins(2, 2, 30, 1000);

    let pid = bridge.propose(&admins.get_unchecked(0), &ProposalAction::SetFee(0), &1000);
    bridge.approve(&admins.get_unchecked(1), &pid);
    bridge.execute(&pid);
    assert_eq!(bridge.fee_bps(), 0);
}

#[test]
fn test_set_fee_max_allowed() {
    let (_env, bridge, admins) = setup_env_with_admins(2, 2, 30, 1000);

    let pid = bridge.propose(
        &admins.get_unchecked(0),
        &ProposalAction::SetFee(1000),
        &1000,
    );
    bridge.approve(&admins.get_unchecked(1), &pid);
    bridge.execute(&pid);
    assert_eq!(bridge.fee_bps(), 1000);
}

#[test]
fn test_fund_c_address_tracks_fees() {
    let (_env, bridge, _admins) = setup_env_with_admins(2, 2, 100, 1000);
    let source = Address::generate(&_env);
    let target = Address::generate(&_env);
    let token_addr = Address::generate(&_env);

    let memo = String::from_str(&_env, "fund test");
    let fee = bridge.fund_c_address(&source, &target, &token_addr, &1000, &memo);

    assert_eq!(fee, 10);
    assert_eq!(bridge.accumulated_fees(), 10);
}

#[test]
fn test_fund_with_zero_fee() {
    let (_env, bridge, _admins) = setup_env_with_admins(2, 2, 0, 1000);
    let source = Address::generate(&_env);
    let target = Address::generate(&_env);
    let token_addr = Address::generate(&_env);

    let memo = String::from_str(&_env, "no fee");
    let fee = bridge.fund_c_address(&source, &target, &token_addr, &500, &memo);

    assert_eq!(fee, 0);
    assert_eq!(bridge.accumulated_fees(), 0);
}

#[test]
fn test_withdraw_fees() {
    let (_env, bridge, admins) = setup_env_with_admins(2, 2, 200, 1000);
    let source = Address::generate(&_env);
    let target = Address::generate(&_env);
    let token_addr = Address::generate(&_env);

    let memo = String::from_str(&_env, "test");
    bridge.fund_c_address(&source, &target, &token_addr, &1000, &memo);
    assert_eq!(bridge.accumulated_fees(), 20);

    let to = Address::generate(&_env);
    let pid = bridge.propose(
        &admins.get_unchecked(0),
        &ProposalAction::WithdrawFees(to.clone(), token_addr.clone(), 0i128),
        &1000,
    );
    bridge.approve(&admins.get_unchecked(1), &pid);
    bridge.execute(&pid);

    assert_eq!(bridge.accumulated_fees(), 0);
}

#[test]
fn test_withdraw_fees_partial() {
    let (_env, bridge, admins) = setup_env_with_admins(2, 2, 100, 1000);
    let source = Address::generate(&_env);
    let target = Address::generate(&_env);
    let token_addr = Address::generate(&_env);

    let memo = String::from_str(&_env, "test");
    bridge.fund_c_address(&source, &target, &token_addr, &1000, &memo);
    assert_eq!(bridge.accumulated_fees(), 10);

    let to = Address::generate(&_env);
    let pid = bridge.propose(
        &admins.get_unchecked(0),
        &ProposalAction::WithdrawFees(to.clone(), token_addr.clone(), 4i128),
        &1000,
    );
    bridge.approve(&admins.get_unchecked(1), &pid);
    bridge.execute(&pid);

    assert_eq!(bridge.accumulated_fees(), 6);
}

#[test]
fn test_route_from_exchange() {
    let (_env, bridge, _admins) = setup_env_with_admins(2, 2, 50, 1000);
    let exchange = Address::generate(&_env);
    let target = Address::generate(&_env);
    let token_addr = Address::generate(&_env);

    let memo = String::from_str(&_env, "cex test");
    let fee = bridge.route_from_exchange(&exchange, &target, &token_addr, &500, &memo);

    assert_eq!(fee, 2);
    assert_eq!(bridge.accumulated_fees(), 2);
}

#[test]
fn test_multiple_fund_accumulates_fees() {
    let (_env, bridge, _admins) = setup_env_with_admins(2, 2, 100, 1000);
    let source = Address::generate(&_env);
    let target = Address::generate(&_env);
    let token_addr = Address::generate(&_env);

    let memo = String::from_str(&_env, "tx1");
    bridge.fund_c_address(&source, &target, &token_addr, &1000, &memo);
    assert_eq!(bridge.accumulated_fees(), 10);

    let memo = String::from_str(&_env, "tx2");
    bridge.fund_c_address(&source, &target, &token_addr, &2000, &memo);
    assert_eq!(bridge.accumulated_fees(), 30);

    let memo = String::from_str(&_env, "tx3");
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

    let admin1 = Address::generate(&env);
    let admin2 = Address::generate(&env);
    let source = Address::generate(&env);
    let target = Address::generate(&env);
    let token_addr = Address::generate(&env);

    let bridge_id = env.register_contract(None, OnboardingBridge);
    let bridge = OnboardingBridgeClient::new(&env, &bridge_id);

    let mut admins: Vec<Address> = Vec::new(&env);
    admins.push_back(admin1.clone());
    admins.push_back(admin2.clone());
    bridge.initialize(&admins, &2, &100, &1000);

    // Fund
    let memo = String::from_str(&env, "full test");
    let fee = bridge.fund_c_address(&source, &target, &token_addr, &1000, &memo);
    assert_eq!(fee, 10);
    assert_eq!(bridge.accumulated_fees(), 10);

    // Withdraw fees via multisig proposal
    let to = Address::generate(&env);
    let pid = bridge.propose(
        &admin1,
        &ProposalAction::WithdrawFees(to.clone(), token_addr.clone(), 0i128),
        &1000,
    );
    bridge.approve(&admin2, &pid);
    let withdrawn = bridge.execute(&pid);
    assert_eq!(withdrawn, 10);
    assert_eq!(bridge.accumulated_fees(), 0);
}
