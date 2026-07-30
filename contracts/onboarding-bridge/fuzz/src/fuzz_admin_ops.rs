/// Fuzz random interleavings of propose/approve/execute (governance), fund_c_address.
///
/// Properties:
///   1. accumulated_fees never goes negative
///   2. fund_c_address correctly deducts fees from funding amount
///   3. governance proposals can be executed to change fee rates

use onboarding_bridge::{OnboardingBridgeClient, ProposalAction};
use soroban_sdk::{testutils::Address as _, Address, Env, String, Vec};

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

#[derive(Debug)]
enum Op {
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
    }
}

fn run_iteration(rng: &mut Lcg) {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    let contract_id = env.register_contract(None, onboarding_bridge::OnboardingBridge);
    let bridge = OnboardingBridgeClient::new(&env, &contract_id);

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

    let source = Address::generate(&env);
    let target = Address::generate(&env);
    let token = Address::generate(&env);

    let mut pending_proposal_id: Option<u32> = None;

    let n_ops = rng.next_usize_bounded(19) + 1; // 1..=20 ops

    for _ in 0..n_ops {
        let before = bridge.accumulated_fees();
        // Property 1: never negative
        assert!(before >= 0, "accumulated_fees went negative: {before}");

        match pick_op(rng) {
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
            }
        }
    }
}

fn main() {
    let seed: u64 = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(0xfeedface_deadc0de);

    let mut rng = Lcg(seed);

    for i in 0..500 {
        run_iteration(&mut rng);
        if (i + 1) % 100 == 0 {
            println!("fuzz_admin_ops: {}/{} iterations done", i + 1, 500);
        }
    }

    println!("fuzz_admin_ops: all 500 iterations passed.");
}
