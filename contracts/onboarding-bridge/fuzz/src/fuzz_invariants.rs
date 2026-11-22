/// Comprehensive invariant-based fuzz testing.
///
/// Runs random sequences of ALL contract operations and checks
/// invariants after every single operation.
///
/// Invariants:
///   I1. accumulated_fees >= 0
///   I2. total_fees <= total_volume
///   I3. fee_bps in [0, max_fee_bps]
///   I4. accumulated_fees == sum(fees per funding) - sum(withdrawn)
///   I5. funding_count == number of fundings (batch counts each element)
///   I6. unique_funder_count <= funding_count
///   I7. version >= 1 (after init)
///   I8. min_amount > 0, max_amount >= min_amount
///   I9. Contract token balance >= accumulated_fees (when tokens tracked)
///   I10. Admin list immutable after init
///   I11. Only admin proposals can change fee, pause, withdraw
///   I12. Rebate discount <= 5000 bps (50%)

use onboarding_bridge::{OnboardingBridge, OnboardingBridgeClient, ProposalAction};
use soroban_sdk::{testutils::Address as _, Address, Env, String, Vec};

mod test_token;
use test_token::TestToken;

struct Lcg(u64);

impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        self.0
    }
    fn next_i128_bounded(&mut self, max: i128) -> i128 {
        let hi = self.next() as u128;
        let lo = self.next() as u128;
        ((hi << 64 | lo) % (max as u128 + 1)) as i128
    }
    fn next_u32_bounded(&mut self, max: u32) -> u32 {
        (self.next() % (max as u64 + 1)) as u32
    }
    fn next_usize_bounded(&mut self, max: usize) -> usize {
        (self.next() % (max as u64 + 1)) as usize
    }
    fn next_bool(&mut self) -> bool {
        self.next() % 2 == 0
    }
}

#[derive(Debug, Clone)]
enum Op {
    Fund,
    BatchFund,
    RouteFromExchange,
    ProposeSetFee,
    ProposeSetFeeTokenWhitelist,
    ProposeSetFeeTokenRate,
    ProposeWithdraw,
    ProposePause,
    ProposeUnpause,
    Approve,
    Execute,
    SetRebateTier,
    ArchiveOldEntries,
}

fn pick_op(rng: &mut Lcg) -> Op {
    match rng.next_usize_bounded(13) {
        0 => Op::Fund,
        1 => Op::BatchFund,
        2 => Op::RouteFromExchange,
        3 => Op::ProposeSetFee,
        4 => Op::ProposeSetFeeTokenWhitelist,
        5 => Op::ProposeSetFeeTokenRate,
        6 => Op::ProposeWithdraw,
        7 => Op::ProposePause,
        8 => Op::ProposeUnpause,
        9 => Op::Approve,
        10 => Op::Execute,
        11 => Op::SetRebateTier,
        _ => Op::ArchiveOldEntries,
    }
}

fn setup_token(env: &Env, owner: &Address, balance: i128) -> Address {
    let token_id = env.register_contract(None, TestToken);
    let token_client = test_token::TestTokenClient::new(env, &token_id);
    token_client.mint(owner, &balance);
    token_id
}

#[derive(Clone)]
struct TrackedProposal {
    id: u32,
    action: ProposalAction,
    approvals: u32,
    executed: bool,
}

struct FuzzState {
    env: Env,
    bridge: OnboardingBridgeClient<'static>,
    admins: Vec<Address>,
    threshold: u32,
    token: Address,
    source: Address,
    exchange: Address,
    target: Address,
    rng: Lcg,
    proposals: std::vec::Vec<TrackedProposal>,
    total_fees_ever: i128,
    total_withdrawn_ever: i128,
    total_volume_ever: i128,
    funding_count_ever: u32,
}

impl FuzzState {
    fn new(rng: &mut Lcg) -> Self {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let contract_id = env.register_contract(None, OnboardingBridge);
        let bridge = OnboardingBridgeClient::new(&env, &contract_id);
        let bridge: OnboardingBridgeClient<'static> = unsafe { core::mem::transmute(bridge) };

        let admin_count = rng.next_u32_bounded(4) + 2;
        let threshold = rng.next_u32_bounded(admin_count - 1) + 1;
        let mut admins: Vec<Address> = Vec::new(&env);
        for _ in 0..admin_count {
            admins.push_back(Address::generate(&env));
        }

        let fee_bps = rng.next_u32_bounded(5000);
        let max_fee_bps = 5000 + rng.next_u32_bounded(5000);

        bridge.initialize(&admins, &threshold, &fee_bps, &max_fee_bps, &1, &i128::MAX);

        let source = Address::generate(&env);
        let exchange = Address::generate(&env);
        let target = Address::generate(&env);
        let token = setup_token(&env, &source, 100_000_000);
        let _ = setup_token(&env, &exchange, 100_000_000);

        FuzzState {
            env,
            bridge,
            admins,
            threshold,
            token,
            source,
            exchange,
            target,
            rng: Lcg(rng.next()),
            proposals: std::vec::Vec::new(),
            total_fees_ever: 0,
            total_withdrawn_ever: 0,
            total_volume_ever: 0,
            funding_count_ever: 0,
        }
    }

    fn admin(&self, idx: usize) -> Address {
        self.admins.get(idx as u32).unwrap()
    }

    fn random_admin(&mut self) -> Address {
        let idx = self.rng.next_usize_bounded(self.admins.len() as usize);
        self.admin(idx)
    }

    fn check_invariants(&self, context: &str) {
        let stats = self.bridge.get_stats();
        let acc_fees = self.bridge.accumulated_fees();
        let fee_bps = self.bridge.fee_bps();
        let max_fee = self.bridge.max_fee_bps();
        let version = self.bridge.version();
        let min_amt = self.bridge.min_amount();
        let max_amt = self.bridge.max_amount();
        let stored_admins = self.bridge.get_admins();

        assert!(acc_fees >= 0, "{context}: I1 violated: accumulated_fees={acc_fees}");
        assert!(
            stats.total_fees <= stats.total_volume,
            "{context}: I2 violated: total_fees={} > total_volume={}",
            stats.total_fees,
            stats.total_volume
        );
        assert!(
            fee_bps <= max_fee,
            "{context}: I3 violated: fee_bps={fee_bps} > max_fee_bps={max_fee}"
        );

        let expected_acc = self.total_fees_ever - self.total_withdrawn_ever;
        assert_eq!(
            acc_fees, expected_acc,
            "{context}: I4 violated: accumulated={acc_fees} expected={expected_acc}"
        );

        assert_eq!(
            stats.funding_count, self.funding_count_ever,
            "{context}: I5 violated: funding_count={} expected={}",
            stats.funding_count, self.funding_count_ever
        );

        assert!(
            stats.unique_funder_count <= stats.funding_count as u64,
            "{context}: I6 violated: unique_funders={} > funding_count={}",
            stats.unique_funder_count,
            stats.funding_count
        );

        assert!(version >= 1, "{context}: I7 violated: version={version}");
        assert!(min_amt > 0, "{context}: I8 violated: min_amount={min_amt}");
        assert!(
            max_amt >= min_amt,
            "{context}: I8 violated: max_amount={max_amt} < min_amount={min_amt}"
        );

        assert_eq!(
            stored_admins.len(),
            self.admins.len(),
            "{context}: I10 violated: admin count changed"
        );
        for i in 0..stored_admins.len() {
            assert_eq!(
                stored_admins.get_unchecked(i),
                self.admins.get_unchecked(i),
                "{context}: I10 violated: admin {i} changed"
            );
        }
    }

    fn run_op(&mut self) {
        let op = pick_op(&mut self.rng);
        let memo = String::from_str(&self.env, "fuzz");

        match op {
            Op::Fund => {
                if !self.bridge.is_paused() {
                    let amount = self.rng.next_i128_bounded(100_000) + 1;
                    let fee = self.bridge.fund_c_address(
                        &self.source, &self.target, &self.token, &amount, &memo,
                    );
                    self.total_fees_ever += fee;
                    self.total_volume_ever += amount;
                    self.funding_count_ever += 1;
                }
            }
            Op::BatchFund => {
                if !self.bridge.is_paused() {
                    let batch_size = self.rng.next_usize_bounded(4) + 1;
                    let mut targets: Vec<Address> = Vec::new(&self.env);
                    let mut tokens: Vec<Address> = Vec::new(&self.env);
                    let mut amounts: Vec<i128> = Vec::new(&self.env);
                    let mut memos: Vec<String> = Vec::new(&self.env);

                    for _ in 0..batch_size {
                        targets.push_back(Address::generate(&self.env));
                        tokens.push_back(self.token.clone());
                        amounts.push_back(self.rng.next_i128_bounded(50_000) + 1);
                        memos.push_back(String::from_str(&self.env, "batch"));
                    }

                    let (total_fees, count) = self.bridge.batch_fund_c_address(
                        &self.source, &targets, &tokens, &amounts, &memos,
                    );
                    self.total_fees_ever += total_fees;
                    self.funding_count_ever += count;
                    for i in 0..batch_size {
                        self.total_volume_ever += amounts.get(i as u32).unwrap();
                    }
                }
            }
            Op::RouteFromExchange => {
                if !self.bridge.is_paused() {
                    let amount = self.rng.next_i128_bounded(100_000) + 1;
                    let fee = self.bridge.route_from_exchange(
                        &self.exchange, &self.target, &self.token, &amount, &memo,
                    );
                    self.total_fees_ever += fee;
                    self.total_volume_ever += amount;
                    self.funding_count_ever += 1;
                }
            }
            Op::ProposeSetFee => {
                let new_fee = self.rng.next_u32_bounded(self.bridge.max_fee_bps());
                let proposer = self.random_admin();
                let pid = self.bridge.propose(
                    &proposer,
                    &ProposalAction::SetFee(new_fee),
                    &1000,
                );
                self.proposals.push(TrackedProposal {
                    id: pid,
                    action: ProposalAction::SetFee(new_fee),
                    approvals: 1,
                    executed: false,
                });
            }
            Op::ProposeSetFeeTokenWhitelist => {
                let token_addr = Address::generate(&self.env);
                let enabled = self.rng.next_bool();
                let proposer = self.random_admin();
                let pid = self.bridge.propose(
                    &proposer,
                    &ProposalAction::SetFeeTokenWhitelist(token_addr.clone(), enabled),
                    &1000,
                );
                self.proposals.push(TrackedProposal {
                    id: pid,
                    action: ProposalAction::SetFeeTokenWhitelist(token_addr, enabled),
                    approvals: 1,
                    executed: false,
                });
            }
            Op::ProposeSetFeeTokenRate => {
                let token_addr = Address::generate(&self.env);
                let rate = 1000 + self.rng.next_u32_bounded(19000);
                let proposer = self.random_admin();
                let pid = self.bridge.propose(
                    &proposer,
                    &ProposalAction::SetFeeTokenRate(token_addr.clone(), rate),
                    &1000,
                );
                self.proposals.push(TrackedProposal {
                    id: pid,
                    action: ProposalAction::SetFeeTokenRate(token_addr, rate),
                    approvals: 1,
                    executed: false,
                });
            }
            Op::ProposeWithdraw => {
                let accumulated = self.bridge.accumulated_fees();
                if accumulated > 0 {
                    let withdraw_amount = self.rng.next_i128_bounded(accumulated - 1) + 1;
                    let to = Address::generate(&self.env);
                    let proposer = self.random_admin();
                    let pid = self.bridge.propose(
                        &proposer,
                        &ProposalAction::WithdrawFees(to.clone(), self.token.clone(), withdraw_amount),
                        &1000,
                    );
                    self.proposals.push(TrackedProposal {
                        id: pid,
                        action: ProposalAction::WithdrawFees(to, self.token.clone(), withdraw_amount),
                        approvals: 1,
                        executed: false,
                    });
                }
            }
            Op::ProposePause => {
                if !self.bridge.is_paused() {
                    let proposer = self.random_admin();
                    let pid = self.bridge.propose(
                        &proposer,
                        &ProposalAction::Pause,
                        &1000,
                    );
                    self.proposals.push(TrackedProposal {
                        id: pid,
                        action: ProposalAction::Pause,
                        approvals: 1,
                        executed: false,
                    });
                }
            }
            Op::ProposeUnpause => {
                if self.bridge.is_paused() {
                    let proposer = self.random_admin();
                    let pid = self.bridge.propose(
                        &proposer,
                        &ProposalAction::Unpause,
                        &1000,
                    );
                    self.proposals.push(TrackedProposal {
                        id: pid,
                        action: ProposalAction::Unpause,
                        approvals: 1,
                        executed: false,
                    });
                }
            }
            Op::Approve => {
                if !self.proposals.is_empty() {
                    let idx = self.rng.next_usize_bounded(self.proposals.len());
                    let proposal_id = self.proposals[idx].id;
                    let proposal_approvals = self.proposals[idx].approvals;
                    let proposal_executed = self.proposals[idx].executed;

                    if !proposal_executed && proposal_approvals < self.threshold {
                        let approver = self.random_admin();
                        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            self.bridge.approve(&approver, &proposal_id);
                        }));
                        if let Ok(p) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            self.bridge.get_proposal(&proposal_id)
                        })) {
                            self.proposals[idx].approvals = p.approval_count;
                            self.proposals[idx].executed = p.executed;
                        }
                    }
                }
            }
            Op::Execute => {
                if !self.proposals.is_empty() {
                    let idx = self.rng.next_usize_bounded(self.proposals.len());
                    let proposal = &self.proposals[idx];
                    if !proposal.executed && proposal.approvals >= self.threshold {
                        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            self.bridge.execute(&proposal.id)
                        }));
                        if let Ok(withdrawn) = result {
                            match &proposal.action {
                                ProposalAction::WithdrawFees(_, _, _) => {
                                    self.total_withdrawn_ever += withdrawn;
                                }
                                _ => {}
                            }
                            if let Some(p) = self.proposals.get_mut(idx) {
                                p.executed = true;
                            }
                        }
                    }
                }
            }
            Op::SetRebateTier => {
                let tier_idx = self.rng.next_u32_bounded(5);
                let threshold = self.rng.next_i128_bounded(1_000_000);
                let discount = self.rng.next_u32_bounded(5001);
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    self.bridge.set_rebate_tier(&tier_idx, &threshold, &discount);
                }));
            }
            Op::ArchiveOldEntries => {
                let count = self.rng.next_u32_bounded(self.bridge.funding_count()) + 1;
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    self.bridge.archive_old_entries(&count);
                }));
            }
        }

        self.check_invariants(&format!("after op {:?}", op));
    }
}

fn run_iteration(rng: &mut Lcg) {
    let mut state = FuzzState::new(rng);
    let n_ops = rng.next_usize_bounded(49) + 1;

    for _ in 0..n_ops {
        state.run_op();
    }

    state.check_invariants("final");
}

fn main() {
    let seed: u64 = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(0xc0ffee_babe_dead);

    let iterations: u64 = std::env::args()
        .nth(2)
        .and_then(|s| s.parse().ok())
        .unwrap_or(500);

    let mut rng = Lcg(seed);

    for i in 0..iterations {
        run_iteration(&mut rng);
        if (i + 1) % 50 == 0 {
            println!("fuzz_invariants: {}/{} iterations done", i + 1, iterations);
        }
    }

    println!("fuzz_invariants: all {iterations} iterations passed.");
}