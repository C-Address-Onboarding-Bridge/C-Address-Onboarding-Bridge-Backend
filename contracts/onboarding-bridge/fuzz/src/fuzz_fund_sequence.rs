/// Fuzz random sequences of fund_c_address calls.
///
/// Property: accumulated_fees == sum of all individual fees returned.

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

fn run_iteration(rng: &mut Lcg) {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    let contract_id = env.register_contract(None, onboarding_bridge::OnboardingBridge);
    let bridge = OnboardingBridgeClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let fee_bps = rng.next_u32_bounded(10000);
    bridge.initialize(&admin, &fee_bps);

    let source = Address::generate(&env);
    let target = Address::generate(&env);
    let token = Address::generate(&env);

    // 1..=10 funding calls per iteration
    let n_calls = rng.next_usize_bounded(9) + 1;
    let max_amount: i128 = 1_000_000_000;
    let mut expected_fees: i128 = 0;

    for _ in 0..n_calls {
        let amount = rng.next_i128_bounded(max_amount) + 1; // at least 1
        let memo = String::from_str(&env, "fuzz");
        let fee = bridge.fund_c_address(&source, &target, &token, &amount, &memo);
        expected_fees += fee;
    }

    let actual = bridge.accumulated_fees();
    assert_eq!(
        actual, expected_fees,
        "accumulated_fees mismatch: got {actual}, expected {expected_fees}"
    );
}

fn main() {
    let seed: u64 = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(0x1234567890abcdef);

    let mut rng = Lcg(seed);

    for i in 0..1000 {
        run_iteration(&mut rng);
        if (i + 1) % 100 == 0 {
            println!("fuzz_fund_sequence: {}/{} iterations done", i + 1, 1000);
        }
    }

    println!("fuzz_fund_sequence: all 1000 iterations passed.");
}
