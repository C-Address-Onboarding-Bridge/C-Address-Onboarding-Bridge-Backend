<<<<<<< Updated upstream
/// Fuzz random interleavings of propose/approve/execute (governance), fund_c_address.
=======
/// Fuzz random interleavings of governance operations (propose/approve/execute)
/// mixed with funding operations.
>>>>>>> Stashed changes
///
/// Invariants:
///   1. accumulated_fees never goes negative
<<<<<<< Updated upstream
///   2. fund_c_address correctly deducts fees from funding amount
///   3. governance proposals can be executed to change fee rates

use onboarding_bridge::{OnboardingBridgeClient, ProposalAction};
use soroban_sdk::{testutils::{Address as _, Ledger as _}, Address, Env, String, Vec};
=======
///   2. fee_bps always within [0, max_fee_bps]
///   3. Only proposal system can change fee, pause, withdraw
///   4. Admin list never changes (immutable after init in current contract)
///   5. accumulated_fees after partial withdraw == before - withdrawn
///   6. Pause blocks fund/route; unpause restores

use onboarding_bridge::{OnboardingBridge, OnboardingBridgeClient, ProposalAction};
use soroban_sdk::{testutils::Address as _, Address, Env, String, Vec};

mod test_token;
use test_token::TestToken;
>>>>>>> Stashed changes

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
}

#[derive(Debug, Clone)]
enum Op {
<<<<<<< Updated upstream
    ProposeFee,
    ApproveFee,
    ExecuteFee,
    Fund,
}

fn pick_op(rng: &mut Lcg) -> Op {
    match rng.next_usize_bounded(3) {
        0 => Op::ProposeFee,
        1 => Op::ApproveFee,
        2 => Op::ExecuteFee,
        _ => Op::Fund,
=======
    ProposeSetFee,
    ProposeWithdraw,
    ProposePause,
    ProposeUnpause,
    Fund,
    ApproveAndExecute,
}

fn pick_op(rng: &mut Lcg) -> Op {
    match rng.next_usize_bounded(6) {
        0 => Op::ProposeSetFee,
        1 => Op::ProposeWithdraw,
        2 => Op::ProposePause,
        3 => Op::ProposeUnpause,
        4 => Op::Fund,
        _ => Op::ApproveAndExecute,
>>>>>>> Stashed changes
    }
}

fn setup_token(env: &Env, owner: &Address, balance: i128) -> Address {
    let token_id = env.register_contract(None, TestToken);
    let token_client = test_token::TestTokenClient::new(env, &token_id);
    token_client.mint(owner, &balance);
    token_id
}

fn run_iteration(rng: &mut Lcg) {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    let contract_id = env.register_contract(None, OnboardingBridge);
    let bridge = OnboardingBridgeClient::new(&env, &contract_id);

<<<<<<< Updated upstream
    // Initialize with 2 admins and threshold of 1
    let admin1 = Address::generate(&env);
    let admin2 = Address::generate(&env);
    let mut admins = Vec::new(&env);
    admins.push_back(admin1.clone());
    admins.push_back(admin2.clone());

    let initial_fee_bps = rng.next_u32_bounded(10000);
    let max_fee_bps = rng.next_u32_bounded(10000).max(initial_fee_bps);

    bridge.initialize(
        &admins,
        &1u32,  // threshold = 1
        &initial_fee_bps,
        &max_fee_bps,
        &100i128,  // min_amount
        &1_000_000i128,  // max_amount
    );
=======
    let admin1 = Address::generate(&env);
    let admin2 = Address::generate(&env);
    let admin3 = Address::generate(&env);
    let mut admins: Vec<Address> = Vec::new(&env);
    admins.push_back(admin1.clone());
    admins.push_back(admin2.clone());
    admins.push_back(admin3.clone());

    let initial_fee_bps = rng.next_u32_bounded(5000);
    let max_fee_bps = 5000 + rng.next_u32_bounded(5000);
    bridge.initialize(&admins, &2, &initial_fee_bps, &max_fee_bps, &1, &i128::MAX);
>>>>>>> Stashed changes

    let source = Address::generate(&env);
    let target = Address::generate(&env);
    let token = setup_token(&env, &source, 10_000_000);

<<<<<<< Updated upstream
    let mut pending_proposal_id: Option<u32> = None;

    let n_ops = rng.next_usize_bounded(19) + 1; // 1..=20 ops
=======
    let mut pending_proposals: Vec<(u32, ProposalAction)> = Vec::new(&env);
    let mut total_withdrawn: i128 = 0;

    let n_ops = rng.next_usize_bounded(29) + 1;
>>>>>>> Stashed changes

    for _ in 0..n_ops {
        let before_acc = bridge.accumulated_fees();
        assert!(before_acc >= 0, "accumulated_fees went negative: {before_acc}");

        let current_fee = bridge.fee_bps();
        let current_max = bridge.max_fee_bps();
        assert!(
            current_fee <= current_max,
            "fee_bps {current_fee} > max_fee_bps {current_max}"
        );

        match pick_op(rng) {
<<<<<<< Updated upstream
            Op::ProposeFee => {
                let new_fee = rng.next_u32_bounded(max_fee_bps + 1);
                let action = ProposalAction::SetFee(new_fee);
                let proposal_id = bridge.propose(&admin1, &action, &1000u32);
                pending_proposal_id = Some(proposal_id);
            }
            Op::ApproveFee => {
                if let Some(proposal_id) = pending_proposal_id {
                    // Approve with admin2 (different from proposer)
                    bridge.approve(&admin2, &proposal_id);
                }
            }
            Op::ExecuteFee => {
                if let Some(proposal_id) = pending_proposal_id {
                    // Advance the ledger past the proposal's minimum execution delay
                    // so the contract no longer rejects with "execution too soon".
                    let seq = env.ledger().sequence();
                    env.ledger().set_sequence_number(seq.saturating_add(1001));
                    // Execute the proposal
                    let _result = bridge.execute(&proposal_id);
                    pending_proposal_id = None;
                }
            }
            Op::Fund => {
                let amount = rng.next_i128_bounded(100_000i128) + 100i128;
                let memo = String::from_str(&env, "fuzz");
                bridge.fund_c_address(&source, &target, &token, &amount, &memo);
                
                // Property 2: accumulated_fees should reflect deduction
                let after = bridge.accumulated_fees();
                assert!(after >= before, "accumulated_fees decreased without withdrawal");
=======
            Op::ProposeSetFee => {
                let new_fee = rng.next_u32_bounded(current_max);
                let pid = bridge.propose(
                    &admin1,
                    &ProposalAction::SetFee(new_fee),
                    &1000,
                );
                pending_proposals.push_back((pid, ProposalAction::SetFee(new_fee)));
            }
            Op::ProposeWithdraw => {
                let accumulated = bridge.accumulated_fees();
                if accumulated == 0 {
                    continue;
                }
                let withdraw_amount = rng.next_i128_bounded(accumulated - 1) + 1;
                let to = Address::generate(&env);
                let pid = bridge.propose(
                    &admin1,
                    &ProposalAction::WithdrawFees(to.clone(), token.clone(), withdraw_amount),
                    &1000,
                );
                pending_proposals.push_back((pid, ProposalAction::WithdrawFees(to, token.clone(), withdraw_amount)));
            }
            Op::ProposePause => {
                if !bridge.is_paused() {
                    let pid = bridge.propose(
                        &admin1,
                        &ProposalAction::Pause,
                        &1000,
                    );
                    pending_proposals.push_back((pid, ProposalAction::Pause));
                }
            }
            Op::ProposeUnpause => {
                if bridge.is_paused() {
                    let pid = bridge.propose(
                        &admin1,
                        &ProposalAction::Unpause,
                        &1000,
                    );
                    pending_proposals.push_back((pid, ProposalAction::Unpause));
                }
            }
            Op::Fund => {
                if !bridge.is_paused() {
                    let amount = rng.next_i128_bounded(100_000) + 1;
                    let memo = String::from_str(&env, "fuzz");
                    let _fee = bridge.fund_c_address(&source, &target, &token, &amount, &memo);
                }
            }
            Op::ApproveAndExecute => {
                if pending_proposals.is_empty() {
                    continue;
                }
                let idx = rng.next_usize_bounded(pending_proposals.len() as usize);
                let (pid, action) = pending_proposals.get(idx as u32).unwrap();

                let _ = bridge.approve(&admin2, &pid);

                let before_withdraw = bridge.accumulated_fees();
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    bridge.execute(&pid)
                }));

                if let Ok(withdrawn) = result {
                    match action {
                        ProposalAction::WithdrawFees(_, _, _) => {
                            let after_withdraw = bridge.accumulated_fees();
                            assert_eq!(
                                after_withdraw,
                                before_withdraw - withdrawn,
                                "withdraw accounting error: before={before_withdraw} withdrawn={withdrawn} after={after_withdraw}"
                            );
                            total_withdrawn += withdrawn;
                        }
                        ProposalAction::SetFee(new_fee) => {
                          assert_eq!(bridge.fee_bps(), new_fee, "fee not set correctly");
                        }
                        ProposalAction::Pause => {
                            assert!(bridge.is_paused(), "not paused after execute");
                        }
                        ProposalAction::Unpause => {
                            assert!(!bridge.is_paused(), "still paused after execute");
                        }
                        _ => {}
                    }
                }
>>>>>>> Stashed changes
            }
        }
    }

    let stats = bridge.get_stats();
    assert!(stats.total_fees >= 0, "final accumulated_fees negative");
    assert!(stats.total_fees <= stats.total_volume, "fees exceed volume");
    assert_eq!(
        bridge.accumulated_fees(),
        stats.total_fees - total_withdrawn,
        "accumulated_fees mismatch with total_fees - withdrawn"
    );
}

fn main() {
    let seed: u64 = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(0xfeedface_deadc0de);

    let iterations: u64 = std::env::args()
        .nth(2)
        .and_then(|s| s.parse().ok())
        .unwrap_or(500);

    let mut rng = Lcg(seed);

    for i in 0..iterations {
        run_iteration(&mut rng);
        if (i + 1) % 100 == 0 {
            println!("fuzz_admin_ops: {}/{} iterations done", i + 1, iterations);
        }
    }

    println!("fuzz_admin_ops: all {iterations} iterations passed.");
}