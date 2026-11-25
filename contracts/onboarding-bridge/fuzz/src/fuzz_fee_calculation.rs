/// Property-based fuzz test for the contract's fee calculation.
///
/// Every iteration registers a fresh `OnboardingBridge`, sets a random
/// `fee_bps`, installs random rebate tiers through the real proposal flow
/// (`propose` + `execute` with `ProposalAction::SetRebateTier`), and then calls
/// `fund_c_address` with a test token several times. The fee the contract
/// returns and the token balances it moves are checked against the expected
/// values derived from the documented fee rules:
///
///   discount      = max tier discount whose threshold <= the source's volume
///                   *before* this call (tier discounts are capped at 5 000 bps)
///   effective_bps = fee_bps - fee_bps * discount / 10 000
///   fee           = amount * effective_bps / 10 000   (floor)
///
/// Invariants:
///   1. returned fee == expected fee, and 0 <= fee <= amount
///   2. fee <= the no-rebate fee (a rebate never raises the fee)
///   3. fee == 0 when fee_bps == 0
///   4. token conservation: source -amount, target +(amount - fee),
///      contract +fee
///   5. accumulated_fees grows by exactly the fee
///   6. rebate_for(source) == the discount expected from the tiers
///
/// Usage: `fuzz_fee_calculation [SEED] [ITERATIONS]`. The seed is printed so a
/// failing run can be replayed.

use onboarding_bridge::{OnboardingBridge, OnboardingBridgeClient, ProposalAction};
use soroban_sdk::{testutils::Address as _, Address, Env, String, Vec};

mod test_token;
use test_token::{TestToken, TestTokenClient};

/// Tier discounts above this are rejected by the contract.
const MAX_TIER_DISCOUNT_BPS: u32 = 5_000;
/// Largest single funding amount; keeps sums of several fundings far from
/// i128 overflow while still covering large values.
const MAX_AMOUNT: i128 = 1_000_000_000_000_000_000_000_000; // 1e24
const MAX_TIERS_USED: u32 = 4;
const MAX_FUNDINGS: usize = 6;

/// Minimal LCG PRNG (Numerical Recipes parameters).
struct Lcg(u64);

impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        self.0
    }

    fn next_i128_bounded(&mut self, max: i128) -> i128 {
        let hi = self.next() as u128;
        let lo = self.next() as u128;
        let wide = (hi << 64) | lo;
        (wide % (max as u128 + 1)) as i128
    }

    fn next_u32_bounded(&mut self, max: u32) -> u32 {
        (self.next() % (max as u64 + 1)) as u32
    }

    /// Amounts skewed towards edge cases: tiny, round and huge values.
    fn next_amount(&mut self) -> i128 {
        match self.next_u32_bounded(4) {
            0 => self.next_i128_bounded(100) + 1,
            1 => (self.next_i128_bounded(1_000) + 1) * 10_000,
            2 => MAX_AMOUNT - self.next_i128_bounded(1_000),
            _ => self.next_i128_bounded(MAX_AMOUNT - 1) + 1,
        }
    }
}

/// The rule the contract documents, applied to values this harness tracks.
fn expected_fee(amount: i128, fee_bps: u32, discount_bps: u32) -> i128 {
    let effective = fee_bps.saturating_sub(fee_bps * discount_bps / 10_000);
    amount * effective as i128 / 10_000
}

fn expected_discount(tiers: &[(i128, u32)], volume: i128) -> u32 {
    tiers
        .iter()
        .filter(|(threshold, _)| volume >= *threshold)
        .map(|(_, discount)| *discount)
        .max()
        .unwrap_or(0)
}

/// Runs one randomised scenario; returns a description of each violated invariant.
fn run_iteration(rng: &mut Lcg) -> std::vec::Vec<std::string::String> {
    let mut failures = std::vec::Vec::new();
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    let bridge_id = env.register_contract(None, OnboardingBridge);
    let bridge = OnboardingBridgeClient::new(&env, &bridge_id);

    let admin = Address::generate(&env);
    let mut admins: Vec<Address> = Vec::new(&env);
    admins.push_back(admin.clone());

    // fee_bps == 0 is an important edge case, so give it extra weight.
    let fee_bps = if rng.next_u32_bounded(9) == 0 { 0 } else { rng.next_u32_bounded(10_000) };
    bridge.initialize(&admins, &1u32, &fee_bps, &10_000u32, &1i128, &MAX_AMOUNT);

    // Random rebate tiers, installed through the real admin proposal flow.
    let mut tiers: std::vec::Vec<(i128, u32)> = std::vec::Vec::new();
    for tier_index in 0..rng.next_u32_bounded(MAX_TIERS_USED) {
        let threshold = match rng.next_u32_bounded(2) {
            0 => 0,
            1 => rng.next_amount(),
            _ => rng.next_i128_bounded(MAX_AMOUNT * MAX_FUNDINGS as i128),
        };
        let discount = rng.next_u32_bounded(MAX_TIER_DISCOUNT_BPS);
        let pid = bridge.propose(
            &admin,
            &ProposalAction::SetRebateTier(tier_index, threshold, discount),
            &1_000u32,
        );
        bridge.execute(&pid);
        tiers.push((threshold, discount));
    }

    let token_id = env.register_contract(None, TestToken);
    let token = TestTokenClient::new(&env, &token_id);
    let source = Address::generate(&env);
    let target = Address::generate(&env);
    let memo = String::from_str(&env, "fuzz");

    let mut volume: i128 = 0;
    for _ in 0..(rng.next_u32_bounded(MAX_FUNDINGS as u32 - 1) as usize + 1) {
        let amount = rng.next_amount();
        token.mint(&source, &amount);

        let discount = expected_discount(&tiers, volume);
        let want_fee = expected_fee(amount, fee_bps, discount);

        let rebate = bridge.rebate_for(&source, &token_id);
        if rebate != discount {
            failures.push(format!("I6 rebate_for={rebate}, expected {discount} at volume {volume}"));
        }

        let src_before = token.balance(&source);
        let tgt_before = token.balance(&target);
        let bridge_before = token.balance(&bridge_id);
        let acc_before = bridge.accumulated_fees();

        let fee = bridge.fund_c_address(&source, &target, &token_id, &amount, &memo);

        if fee != want_fee {
            failures.push(format!(
                "I1 fee={fee}, expected {want_fee} (amount={amount}, fee_bps={fee_bps}, discount={discount})"
            ));
        }
        if fee < 0 || fee > amount {
            failures.push(format!("I1 fee={fee} outside [0, amount={amount}]"));
        }
        if fee > expected_fee(amount, fee_bps, 0) {
            failures.push(format!("I2 fee={fee} exceeds the no-rebate fee"));
        }
        if fee_bps == 0 && fee != 0 {
            failures.push(format!("I3 fee_bps=0 but fee={fee}"));
        }
        if token.balance(&source) != src_before - amount {
            failures.push(format!("I4 source balance moved by {} not -{amount}", token.balance(&source) - src_before));
        }
        if token.balance(&target) != tgt_before + (amount - fee) {
            failures.push(format!(
                "I4 target received {} not {}",
                token.balance(&target) - tgt_before,
                amount - fee
            ));
        }
        if token.balance(&bridge_id) != bridge_before + fee {
            failures.push(format!("I4 contract kept {} not fee {fee}", token.balance(&bridge_id) - bridge_before));
        }
        if bridge.accumulated_fees() != acc_before + fee {
            failures.push(format!(
                "I5 accumulated_fees grew by {} not {fee}",
                bridge.accumulated_fees() - acc_before
            ));
        }

        volume += amount;
    }
    failures
}

fn main() {
    let seed: u64 = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(0xdeadbeef_cafebabe);

    let iterations: u64 = std::env::args()
        .nth(2)
        .and_then(|s| s.parse().ok())
        .unwrap_or(1_000);

    println!("fuzz_fee_calculation: seed={seed} iterations={iterations}");

    let mut rng = Lcg(seed);
    let mut failures = 0u64;

    for i in 0..iterations {
        for failure in run_iteration(&mut rng) {
            eprintln!("[iter {i}] FAIL {failure}");
            failures += 1;
        }
    }

    if failures == 0 {
        println!("fuzz_fee_calculation: all {iterations} iterations passed (seed={seed}).");
    } else {
        eprintln!("fuzz_fee_calculation: {failures} failures in {iterations} iterations (seed={seed}).");
        std::process::exit(1);
    }
}
