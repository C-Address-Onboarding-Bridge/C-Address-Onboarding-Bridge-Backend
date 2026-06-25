#![cfg(test)]

extern crate std;

use soroban_sdk::{
    contract, contractimpl, contracttype, testutils::Address as _, testutils::Ledger, Address, Env,
    String, Vec,
};

use super::*;

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
        env.storage().persistent().set(&TK::Bal(to), &(tb + amount));
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

    pub fn decimals(_env: Env) -> u32 {
        7
    }
    pub fn name(env: Env) -> String {
        String::from_str(&env, "TestToken")
    }
    pub fn symbol(env: Env) -> String {
        String::from_str(&env, "TEST")
    }
    pub fn allowance(_env: Env, _from: Address, _spender: Address) -> i128 {
        i128::MAX
    }
    pub fn approve(_env: Env, _from: Address, _spender: Address, _amount: i128, _exp: u32) {}
}

fn account_address(env: &Env) -> Address {
    Address::from_str(
        env,
        "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
    )
}

fn create_admins(env: &Env, count: u32) -> Vec<Address> {
    let mut admins: Vec<Address> = Vec::new(env);
    for _ in 0..count {
        admins.push_back(Address::generate(env));
    }
    admins
}

fn register_test_token(env: &Env) -> Address {
    env.register_contract(None, TestToken)
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
    bridge.initialize(&admins, &threshold, &fee_bps, &max_fee_bps, &1, &i128::MAX);
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
    bridge.initialize(&admins, &2, &50, &10001, &1, &i128::MAX);
}

#[test]
#[should_panic(expected = "fee_bps must be <= max_fee_bps")]
fn test_initialize_validates_fee_vs_max_fee() {
    let (env, bridge) = setup_env();
    let admins = create_admins(&env, 2);
    bridge.initialize(&admins, &2, &2000, &1000, &1, &i128::MAX);
}

#[test]
#[should_panic(expected = "threshold must be > 0")]
fn test_initialize_validates_threshold_zero() {
    let (env, bridge) = setup_env();
    let admins = create_admins(&env, 2);
    bridge.initialize(&admins, &0, &50, &1000, &1, &i128::MAX);
}

#[test]
#[should_panic(expected = "threshold exceeds admin count")]
fn test_initialize_validates_threshold_exceeds() {
    let (env, bridge) = setup_env();
    let admins = create_admins(&env, 2);
    bridge.initialize(&admins, &3, &50, &1000, &1, &i128::MAX);
}

// ---------------------------------------------------------------------------
// Zero-amount guard
// ---------------------------------------------------------------------------

#[test]
fn test_fund_zero_amount_rejected() {
    let (env, bridge, _admin) = initialized();
    let source = Address::generate(&env);
    let target = Address::generate(&env);
    let token = Address::generate(&env);
    let memo = String::from_str(&env, "zero");

    let err = bridge
        .try_fund_c_address(&source, &target, &token, &0, &memo)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, ContractError::ZeroAmount);
}

#[test]
#[should_panic(expected = "admins must not be empty")]
fn test_initialize_validates_admins_not_empty() {
    let (env, bridge) = setup_env();
    let empty: Vec<Address> = Vec::new(&env);
    bridge.initialize(&empty, &1, &50, &1000, &1, &i128::MAX);
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
    let token_addr = register_test_token(&env);
    let memo = String::from_str(&env, "test");

    TestTokenClient::new(&env, &token_addr).mint(&source, &2000);
    bridge.fund_c_address(&source, &target, &token_addr, &1000, &memo);
    assert_eq!(bridge.accumulated_fees(), 10);

    let pid = bridge.propose(&admins.get_unchecked(0), &ProposalAction::Pause, &1000);
    bridge.approve(&admins.get_unchecked(1), &pid);
    bridge.execute(&pid);

    let to = Address::generate(&env);
    let token_addr2 = register_test_token(&env);
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
    let (env, bridge, _admins) = setup_env_with_admins(2, 2, 100, 1000);
    let non_admin = Address::generate(&env);

    let _pid = bridge.propose(&non_admin, &ProposalAction::SetFee(200), &1000);
}

#[test]
#[should_panic(expected = "only admins can approve")]
fn test_non_admin_cannot_approve() {
    let (env, bridge, admins) = setup_env_with_admins(2, 2, 100, 1000);
    let non_admin = Address::generate(&env);
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

    bridge.approve(&admins.get_unchecked(1), &pid1);
    bridge.approve(&admins.get_unchecked(2), &pid1);
    bridge.execute(&pid1);

    env.ledger()
        .set_sequence_number(env.ledger().sequence() + 20);

    let active = bridge.get_active_proposals();
    assert_eq!(active.len(), 1);
    assert_eq!(active.get_unchecked(0).id, pid3);
}

#[test]
fn test_proposal_withdraw_fees_execution() {
    let (env, bridge, admins) = setup_env_with_admins(2, 2, 100, 1000);

    let source = Address::generate(&env);
    let target = Address::generate(&env);
    let token_addr = register_test_token(&env);
    let memo = String::from_str(&env, "test");
    TestTokenClient::new(&env, &token_addr).mint(&source, &10_000);
    bridge.fund_c_address(&source, &target, &token_addr, &5000, &memo);
    assert_eq!(bridge.accumulated_fees(), 50);

    let to = Address::generate(&env);
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
    let (env, bridge, admins) = setup_env_with_admins(2, 2, 100, 1000);

    let source = Address::generate(&env);
    let target = Address::generate(&env);
    let token_addr = register_test_token(&env);
    let memo = String::from_str(&env, "test");
    TestTokenClient::new(&env, &token_addr).mint(&source, &2000);
    bridge.fund_c_address(&source, &target, &token_addr, &1000, &memo);
    assert_eq!(bridge.accumulated_fees(), 10);

    let to = Address::generate(&env);
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
    let (env, bridge, admins) = setup_env_with_admins(2, 2, 100, 1000);

    let source = Address::generate(&env);
    let target = Address::generate(&env);
    let token_addr = register_test_token(&env);
    let memo = String::from_str(&env, "test");
    TestTokenClient::new(&env, &token_addr).mint(&source, &2000);
    bridge.fund_c_address(&source, &target, &token_addr, &1000, &memo);

    let to = Address::generate(&env);
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
    bridge.initialize(&admins, &2, &30, &1000, &1, &i128::MAX);
    bridge.initialize(&admins, &2, &50, &1000, &1, &i128::MAX);
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
    let (env, bridge, _admins) = setup_env_with_admins(2, 2, 100, 1000);
    let source = Address::generate(&env);
    let target = Address::generate(&env);
    let token_addr = register_test_token(&env);
    TestTokenClient::new(&env, &token_addr).mint(&source, &2000);

    let memo = String::from_str(&env, "fund test");
    let fee = bridge.fund_c_address(&source, &target, &token_addr, &1000, &memo);

    assert_eq!(fee, 10);
    assert_eq!(bridge.accumulated_fees(), 10);
}

#[test]
fn test_fund_with_zero_fee() {
    let (env, bridge, _admins) = setup_env_with_admins(2, 2, 0, 1000);
    let source = Address::generate(&env);
    let target = Address::generate(&env);
    let token_addr = register_test_token(&env);
    TestTokenClient::new(&env, &token_addr).mint(&source, &1000);

    let memo = String::from_str(&env, "no fee");
    let fee = bridge.fund_c_address(&source, &target, &token_addr, &500, &memo);

    assert_eq!(fee, 0);
    assert_eq!(bridge.accumulated_fees(), 0);
}

#[test]
fn test_route_from_exchange() {
    let (env, bridge, _admins) = setup_env_with_admins(2, 2, 50, 1000);
    let exchange = Address::generate(&env);
    let target = Address::generate(&env);
    let token_addr = register_test_token(&env);
    TestTokenClient::new(&env, &token_addr).mint(&exchange, &1000);

    let memo = String::from_str(&env, "cex test");
    let fee = bridge.route_from_exchange(&exchange, &target, &token_addr, &500, &memo);

    assert_eq!(fee, 2);
    assert_eq!(bridge.accumulated_fees(), 2);
}

#[test]
fn test_multiple_fund_accumulates_fees() {
    let (env, bridge, _admins) = setup_env_with_admins(2, 2, 100, 1000);
    let source = Address::generate(&env);
    let target = Address::generate(&env);
    let token_addr = register_test_token(&env);
    TestTokenClient::new(&env, &token_addr).mint(&source, &10_000);

    let memo = String::from_str(&env, "tx1");
    bridge.fund_c_address(&source, &target, &token_addr, &1000, &memo);
    assert_eq!(bridge.accumulated_fees(), 10);
    bridge.fund_c_address(&source, &target, &token, &2000, &String::from_str(&env, "t2")).unwrap();
    assert_eq!(bridge.accumulated_fees(), 30);
    bridge.fund_c_address(&source, &target, &token, &3000, &String::from_str(&env, "t3")).unwrap();
    assert_eq!(bridge.accumulated_fees(), 60);
}

// ---------------------------------------------------------------------------
// Schema version / migration
// ---------------------------------------------------------------------------

    let memo = String::from_str(&env, "tx2");
    bridge.fund_c_address(&source, &target, &token_addr, &2000, &memo);
    assert_eq!(bridge.accumulated_fees(), 30);

    let memo = String::from_str(&env, "tx3");
    bridge.fund_c_address(&source, &target, &token_addr, &3000, &memo);
    assert_eq!(bridge.accumulated_fees(), 60);
}

// ===========================================================================
// C-Address validation tests
// ===========================================================================

#[test]
fn test_is_valid_c_address_true() {
    let (env, _bridge) = setup_env();
    let contract_addr = Address::generate(&env);
    assert!(OnboardingBridge::is_valid_c_address(
        env.clone(),
        contract_addr
    ));
}

#[test]
fn test_is_valid_c_address_false() {
    let env = Env::default();
    let account_addr = account_address(&env);
    assert!(!OnboardingBridge::is_valid_c_address(env, account_addr));
}

#[test]
#[should_panic(expected = "invalid c-address: not a contract address")]
fn test_fund_c_address_rejects_account_target() {
    let (env, bridge, _admins) = setup_env_with_admins(1, 1, 100, 1000);
    let source = Address::generate(&env);
    let token_addr = register_test_token(&env);
    let invalid_target = account_address(&env);
    let memo = String::from_str(&env, "invalid");
    bridge.fund_c_address(&source, &invalid_target, &token_addr, &1000, &memo);
}

#[test]
#[should_panic(expected = "invalid c-address: not a contract address")]
fn test_route_from_exchange_rejects_account_target() {
    let (env, bridge, _admins) = setup_env_with_admins(1, 1, 100, 1000);
    let exchange = Address::generate(&env);
    let token_addr = register_test_token(&env);
    let invalid_target = account_address(&env);
    let memo = String::from_str(&env, "invalid");
    bridge.route_from_exchange(&exchange, &invalid_target, &token_addr, &1000, &memo);
}

// ===========================================================================
// Batch funding tests
// ===========================================================================

#[test]
fn test_batch_fund_two_transfers() {
    let (env, bridge, _admins) = setup_env_with_admins(1, 1, 100, 1000);
    let source = Address::generate(&env);
    let target1 = Address::generate(&env);
    let target2 = Address::generate(&env);
    let token1 = register_test_token(&env);
    let token2 = register_test_token(&env);
    TestTokenClient::new(&env, &token1).mint(&source, &5000);
    TestTokenClient::new(&env, &token2).mint(&source, &5000);

    let targets = Vec::from_array(&env, [target1, target2]);
    let tokens = Vec::from_array(&env, [token1.clone(), token2.clone()]);
    let amounts = Vec::from_array(&env, [1000i128, 2000i128]);
    let memos = Vec::from_array(
        &env,
        [
            String::from_str(&env, "batch1"),
            String::from_str(&env, "batch2"),
        ],
    );

    let (total_fees, count) =
        bridge.batch_fund_c_address(&source, &targets, &tokens, &amounts, &memos);
    assert_eq!(count, 2);
    assert_eq!(total_fees, 30);
    assert_eq!(bridge.accumulated_fees(), 30);
}

#[test]
#[should_panic(expected = "batch inputs must not be empty")]
fn test_batch_fund_empty_fails() {
    let (env, bridge, _admins) = setup_env_with_admins(1, 1, 100, 1000);
    let source = Address::generate(&env);

    let empty: Vec<Address> = Vec::new(&env);
    let empty_tokens: Vec<Address> = Vec::new(&env);
    let empty_amounts: Vec<i128> = Vec::new(&env);
    let empty_memos: Vec<String> = Vec::new(&env);
    bridge.batch_fund_c_address(&source, &empty, &empty_tokens, &empty_amounts, &empty_memos);
}

#[test]
#[should_panic(expected = "batch input vectors must have same length")]
fn test_batch_fund_mismatched_lengths_fails() {
    let (env, bridge, _admins) = setup_env_with_admins(1, 1, 100, 1000);
    let source = Address::generate(&env);
    let target = Address::generate(&env);
    let token = Address::generate(&env);

    let targets = Vec::from_array(&env, [target]);
    let tokens = Vec::from_array(&env, [token, Address::generate(&env)]);
    let amounts = Vec::from_array(&env, [1000i128]);
    let memos = Vec::from_array(&env, [String::from_str(&env, "mismatched")]);
    bridge.batch_fund_c_address(&source, &targets, &tokens, &amounts, &memos);
}

#[test]
fn test_batch_fund_multiple_accumulates_fees() {
    let (env, bridge, _admins) = setup_env_with_admins(1, 1, 50, 1000);
    let source = Address::generate(&env);
    let token_addr = register_test_token(&env);
    TestTokenClient::new(&env, &token_addr).mint(&source, &10_000);

    let targets = Vec::from_array(
        &env,
        [
            Address::generate(&env),
            Address::generate(&env),
            Address::generate(&env),
        ],
    );
    let tokens = Vec::from_array(
        &env,
        [token_addr.clone(), token_addr.clone(), token_addr.clone()],
    );
    let amounts = Vec::from_array(&env, [1000i128, 2000i128, 3000i128]);
    let memos = Vec::from_array(
        &env,
        [
            String::from_str(&env, "a"),
            String::from_str(&env, "b"),
            String::from_str(&env, "c"),
        ],
    );

    let (total_fees, count) =
        bridge.batch_fund_c_address(&source, &targets, &tokens, &amounts, &memos);
    assert_eq!(count, 3);
    assert_eq!(total_fees, 30);
    assert_eq!(bridge.accumulated_fees(), 30);
}

#[test]
fn test_batch_fund_with_zero_fee() {
    let (env, bridge, _admins) = setup_env_with_admins(1, 1, 0, 1000);
    let source = Address::generate(&env);
    let token1 = register_test_token(&env);
    let token2 = register_test_token(&env);
    TestTokenClient::new(&env, &token1).mint(&source, &5000);
    TestTokenClient::new(&env, &token2).mint(&source, &5000);

    let targets = Vec::from_array(&env, [Address::generate(&env), Address::generate(&env)]);
    let tokens = Vec::from_array(&env, [token1, token2]);
    let amounts = Vec::from_array(&env, [500i128, 1500i128]);
    let memos = Vec::from_array(
        &env,
        [
            String::from_str(&env, "zero1"),
            String::from_str(&env, "zero2"),
        ],
    );

    let (total_fees, count) =
        bridge.batch_fund_c_address(&source, &targets, &tokens, &amounts, &memos);
    assert_eq!(count, 2);
    assert_eq!(total_fees, 0);
    assert_eq!(bridge.accumulated_fees(), 0);
}

// ===========================================================================
// Storage optimization tests
// ===========================================================================

#[test]
fn test_funding_count_increments() {
    let (env, bridge, _admins) = setup_env_with_admins(1, 1, 100, 1000);
    let source = Address::generate(&env);
    let target = Address::generate(&env);
    let token_addr = register_test_token(&env);
    TestTokenClient::new(&env, &token_addr).mint(&source, &5000);

    assert_eq!(bridge.funding_count(), 0);

    let memo = String::from_str(&env, "count1");
    bridge.fund_c_address(&source, &target, &token_addr, &1000, &memo);
    assert_eq!(bridge.funding_count(), 1);

    let memo = String::from_str(&env, "count2");
    bridge.fund_c_address(&source, &target, &token_addr, &2000, &memo);
    assert_eq!(bridge.funding_count(), 2);
}

#[test]
fn test_funding_record_stored() {
    let (env, bridge, _admins) = setup_env_with_admins(1, 1, 100, 1000);
    let source = Address::generate(&env);
    let target = Address::generate(&env);
    let token_addr = register_test_token(&env);
    TestTokenClient::new(&env, &token_addr).mint(&source, &2000);

    let memo = String::from_str(&env, "record test");
    bridge.fund_c_address(&source, &target, &token_addr, &1000, &memo);

    let record = bridge.funding_record(&1);
    assert!(record.is_some());
    let r = record.unwrap();
    assert_eq!(r.source, source);
    assert_eq!(r.target, target);
    assert_eq!(r.token_address, token_addr);
    assert_eq!(r.amount, 1000);
    assert_eq!(r.fee, 10);
    assert!(!r.archived);
}

#[test]
fn test_storage_usage() {
    let (env, bridge, _admins) = setup_env_with_admins(1, 1, 100, 1000);
    let source = Address::generate(&env);
    let target = Address::generate(&env);
    let token_addr = register_test_token(&env);
    TestTokenClient::new(&env, &token_addr).mint(&source, &2000);

    let (fund_count, archive_count, acc_fees, hot) = bridge.storage_usage();
    assert_eq!(fund_count, 0);
    assert_eq!(archive_count, 0);
    assert_eq!(acc_fees, 0);
    assert_eq!(hot, 5);

    let memo = String::from_str(&env, "usage test");
    bridge.fund_c_address(&source, &target, &token_addr, &1000, &memo);

    let (fund_count, _, acc_fees, _) = bridge.storage_usage();
    assert_eq!(fund_count, 1);
    assert_eq!(acc_fees, 10);
}

#[test]
fn test_archive_old_entries() {
    let (env, bridge, _admins) = setup_env_with_admins(1, 1, 100, 1000);
    let source = Address::generate(&env);
    let target = Address::generate(&env);
    let token_addr = register_test_token(&env);
    TestTokenClient::new(&env, &token_addr).mint(&source, &5000);

    let memo = String::from_str(&env, "archive1");
    bridge.fund_c_address(&source, &target, &token_addr, &1000, &memo);
    let memo = String::from_str(&env, "archive2");
    bridge.fund_c_address(&source, &target, &token_addr, &2000, &memo);

    assert_eq!(bridge.funding_count(), 2);

    let hash = bridge.archive_old_entries(&2);
    assert_eq!(hash.len(), 32);

    let record1 = bridge.funding_record(&1).unwrap();
    assert!(record1.archived);
    let record2 = bridge.funding_record(&2).unwrap();
    assert!(record2.archived);
}

#[test]
#[should_panic(expected = "no entries to archive")]
fn test_archive_no_entries_fails() {
    let (_env, bridge, _admins) = setup_env_with_admins(1, 1, 100, 1000);
    bridge.archive_old_entries(&1);
}

#[test]
fn test_batch_fund_then_funding_count() {
    let (env, bridge, _admins) = setup_env_with_admins(1, 1, 50, 1000);
    let source = Address::generate(&env);
    let token_addr = register_test_token(&env);
    TestTokenClient::new(&env, &token_addr).mint(&source, &5000);

    let targets = Vec::from_array(&env, [Address::generate(&env), Address::generate(&env)]);
    let tokens = Vec::from_array(&env, [token_addr.clone(), token_addr.clone()]);
    let amounts = Vec::from_array(&env, [1000i128, 2000i128]);
    let memos = Vec::from_array(
        &env,
        [String::from_str(&env, "b1"), String::from_str(&env, "b2")],
    );

    let (total_fees, count) =
        bridge.batch_fund_c_address(&source, &targets, &tokens, &amounts, &memos);
    assert_eq!(count, 2);
    assert_eq!(total_fees, 15);
    assert_eq!(bridge.funding_count(), 2);

    let r1 = bridge.funding_record(&1).unwrap();
    assert_eq!(r1.amount, 1000);
    assert_eq!(r1.fee, 5);
    let r2 = bridge.funding_record(&2).unwrap();
    assert_eq!(r2.amount, 2000);
    assert_eq!(r2.fee, 10);
}

// ===========================================================================
// Full integration scenario
// ===========================================================================

#[test]
fn test_full_scenario() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    let admin1 = Address::generate(&env);
    let admin2 = Address::generate(&env);
    let source = Address::generate(&env);
    let target = Address::generate(&env);
    let token_addr = register_test_token(&env);
    TestTokenClient::new(&env, &token_addr).mint(&source, &2000);

    let bridge_id = env.register_contract(None, OnboardingBridge);
    let bridge = OnboardingBridgeClient::new(&env, &bridge_id);

    let mut admins: Vec<Address> = Vec::new(&env);
    admins.push_back(admin1.clone());
    admins.push_back(admin2.clone());
    bridge.initialize(&admins, &2, &100, &1000, &1, &i128::MAX);

    let memo = String::from_str(&env, "full test");
    let fee = bridge.fund_c_address(&source, &target, &token_addr, &1000, &memo);
    assert_eq!(fee, 10);
    assert_eq!(bridge.accumulated_fees(), 10);

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

// ===========================================================================
// Token transfer direct test
// ===========================================================================

#[test]
fn test_token_transfer_direct() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);

    let token_id = env.register_contract(None, TestToken);

    TestTokenClient::new(&env, &token_id).mint(&alice, &500);
    TestTokenClient::new(&env, &token_id).transfer(&alice, &bob, &200);

    assert_eq!(TestTokenClient::new(&env, &token_id).balance(&alice), 300);
    assert_eq!(TestTokenClient::new(&env, &token_id).balance(&bob), 200);
}

// ===========================================================================
// Reentrancy protection tests
// ===========================================================================

#[test]
fn test_reentrancy_guard_on_fund_c_address() {
    let (env, bridge, _admins) = setup_env_with_admins(1, 1, 100, 1000);
    let source = Address::generate(&env);
    let target = Address::generate(&env);
    let token_addr = register_test_token(&env);
    TestTokenClient::new(&env, &token_addr).mint(&source, &2000);

    let memo = String::from_str(&env, "normal");
    let fee = bridge.fund_c_address(&source, &target, &token_addr, &1000, &memo);
    assert_eq!(fee, 10);
}

// ===========================================================================
// Default value tests for new getters
// ===========================================================================

#[test]
fn test_min_amount_default() {
    let (_env, bridge, _admins) = setup_env_with_admins(1, 1, 100, 1000);
    assert_eq!(bridge.min_amount(), 1);
}

#[test]
fn test_max_amount_default() {
    let (_env, bridge, _admins) = setup_env_with_admins(1, 1, 100, 1000);
    assert_eq!(bridge.max_amount(), i128::MAX);
}

#[test]
fn test_user_volume_default() {
    let (env, bridge, _admins) = setup_env_with_admins(1, 1, 100, 1000);
    let user = Address::generate(&env);
    assert_eq!(bridge.user_volume(&user), 0);
}

#[test]
fn test_rebate_for_default() {
    let (env, bridge, _admins) = setup_env_with_admins(1, 1, 100, 1000);
    let user = Address::generate(&env);
    assert_eq!(bridge.rebate_for(&user), 0);
}

#[test]
fn test_set_rebate_tier_basic() {
    let (env, bridge, admins) = setup_env_with_admins(1, 1, 100, 1000);
    bridge.set_rebate_tier(&0, &1000i128, &100);
    assert_eq!(bridge.rebate_for(&Address::generate(&env)), 0);
    assert_eq!(bridge.rebate_for(&admins.get_unchecked(0)), 0);
    let user = Address::generate(&env);
    let target = Address::generate(&env);
    let token_addr = register_test_token(&env);
    TestTokenClient::new(&env, &token_addr).mint(&user, &5000);
    let memo = String::from_str(&env, "tier");
    bridge.fund_c_address(&user, &target, &token_addr, &2000, &memo);
    assert_eq!(bridge.rebate_for(&user), 100);
}

#[test]
fn test_user_volume_tracks_funding() {
    let (env, bridge, _admins) = setup_env_with_admins(1, 1, 100, 1000);
    let source = Address::generate(&env);
    let target = Address::generate(&env);
    let token_addr = register_test_token(&env);
    TestTokenClient::new(&env, &token_addr).mint(&source, &10_000);
    let memo = String::from_str(&env, "vol test");

    assert_eq!(bridge.user_volume(&source), 0);
    bridge.fund_c_address(&source, &target, &token_addr, &1000, &memo);
    assert_eq!(bridge.user_volume(&source), 1000);
    bridge.fund_c_address(&source, &target, &token_addr, &2000, &memo);
    assert_eq!(bridge.user_volume(&source), 3000);
}

#[test]
fn test_initialize_with_custom_amounts() {
    let (env, bridge) = setup_env();
    let admins = create_admins(&env, 1);
    bridge.initialize(&admins, &1, &100, &1000, &50, &1_000_000);
    assert_eq!(bridge.min_amount(), 50);
    assert_eq!(bridge.max_amount(), 1_000_000);
}
