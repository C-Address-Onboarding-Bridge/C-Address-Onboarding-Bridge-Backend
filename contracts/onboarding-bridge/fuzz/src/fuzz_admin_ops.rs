/// Fuzz random interleavings of set_fee, fund_c_address, withdraw_fees.
///
/// Properties:
///   1. accumulated_fees never goes negative
///   2. accumulated_fees after partial withdraw == before - withdrawn

use onboarding_bridge::OnboardingBridgeClient;
use soroban_sdk::{testutils::Address as _, Address, Env, String};

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
    SetFee,
    Fund,
    Withdraw,
}

fn pick_op(rng: &mut Lcg) -> Op {
    match rng.next_usize_bounded(2) {
        0 => Op::SetFee,
        1 => Op::Fund,
        _ => Op::Withdraw,
    }
}

fn run_iteration(rng: &mut Lcg) {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    let contract_id = env.register_contract(None, onboarding_bridge::OnboardingBridge);
    let bridge = OnboardingBridgeClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let initial_fee_bps = rng.next_u32_bounded(10000);
    bridge.initialize(&admin, &initial_fee_bps);

    let source = Address::generate(&env);
    let target = Address::generate(&env);
    let token = Address::generate(&env);

    let n_ops = rng.next_usize_bounded(19) + 1; // 1..=20 ops

    for _ in 0..n_ops {
        let before = bridge.accumulated_fees();
        // Property 1: never negative
        assert!(before >= 0, "accumulated_fees went negative: {before}");

        match pick_op(rng) {
            Op::SetFee => {
                let new_fee = rng.next_u32_bounded(10000);
                bridge.set_fee(&new_fee);
            }
            Op::Fund => {
                let amount = rng.next_i128_bounded(1_000_000) + 1;
                let memo = String::from_str(&env, "fuzz");
                bridge.fund_c_address(&source, &target, &token, &amount, &memo);
            }
            Op::Withdraw => {
                let accumulated = bridge.accumulated_fees();
                if accumulated == 0 {
                    continue;
                }
                // Withdraw a random partial amount (1..=accumulated)
                let withdraw_amount = rng.next_i128_bounded(accumulated - 1) + 1;
                let before_withdraw = bridge.accumulated_fees();
                let withdrawn = bridge.withdraw_fees(&admin, &token, &withdraw_amount);
                let after_withdraw = bridge.accumulated_fees();

                // Property 2: after == before - withdrawn
                assert_eq!(
                    after_withdraw,
                    before_withdraw - withdrawn,
                    "withdraw accounting error: before={before_withdraw} withdrawn={withdrawn} after={after_withdraw}"
                );
                // Property 1 again
                assert!(after_withdraw >= 0, "accumulated_fees negative after withdraw: {after_withdraw}");
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
