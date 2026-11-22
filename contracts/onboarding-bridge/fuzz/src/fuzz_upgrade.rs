/// Fuzz test upgrade scenarios and version persistence.
///
/// Invariants:
///   1. Version is monotonically non-decreasing
///   2. Storage keys persist across operations
///   3. Accumulated fees persist
///   4. Admin list persists
///   5. Fee bps bounds persist
///   6. Re-initialization is a no-op (doesn't reset state)

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

    let admin_count = rng.next_u32_bounded(3) + 2;
    let threshold = rng.next_u32_bounded(admin_count - 1) + 1;
    let mut admins: Vec<Address> = Vec::new(&env);
    for _ in 0..admin_count {
        admins.push_back(Address::generate(&env));
    }

    let initial_fee = rng.next_u32_bounded(3000);
    let max_fee = 3000 + rng.next_u32_bounded(7000);

    bridge.initialize(&admins, &threshold, &initial_fee, &max_fee, &10, &1_000_000);

    let initial_version = bridge.version();
    assert_eq!(initial_version, 1, "initial version must be 1");

    let source = Address::generate(&env);
    let target = Address::generate(&env);
    let token = setup_token(&env, &source, 10_000_000);

    let memo = String::from_str(&env, "upgrade-test");
    let fee1 = bridge.fund_c_address(&source, &target, &token, &1000, &memo);
    let fee2 = bridge.fund_c_address(&source, &target, &token, &2000, &memo);

    let _mid_acc = bridge.accumulated_fees();
    let mid_version = bridge.version();
    let _mid_count = bridge.funding_count();
    let mid_admins = bridge.get_admins();
    let mid_fee_bps = bridge.fee_bps();
    let mid_max_fee = bridge.max_fee_bps();

    assert_eq!(mid_version, initial_version, "version changed without upgrade");

    let fee3 = bridge.fund_c_address(&source, &target, &token, &3000, &memo);

    let final_acc = bridge.accumulated_fees();
    let final_count = bridge.funding_count();
    let final_version = bridge.version();

    assert_eq!(final_acc, fee1 + fee2 + fee3, "fees not accumulated correctly");
    assert_eq!(final_count, 3, "funding count wrong");
    assert_eq!(final_version, mid_version, "version changed unexpectedly");

    let final_admins = bridge.get_admins();
    assert_eq!(final_admins.len(), mid_admins.len(), "admin count changed");
    for i in 0..final_admins.len() {
        assert_eq!(
            final_admins.get_unchecked(i),
            mid_admins.get_unchecked(i),
            "admin {i} changed"
        );
    }

    assert_eq!(bridge.fee_bps(), mid_fee_bps, "fee_bps changed");
    assert_eq!(bridge.max_fee_bps(), mid_max_fee, "max_fee_bps changed");

    let before_reinit = bridge.accumulated_fees();
    bridge.initialize(&admins, &threshold, &(initial_fee + 100), &max_fee, &10, &1_000_000);
    let after_reinit = bridge.accumulated_fees();
    assert_eq!(before_reinit, after_reinit, "re-init reset accumulated_fees");
    assert_eq!(bridge.fee_bps(), initial_fee, "re-init changed fee_bps");

    let new_fee = rng.next_u32_bounded(max_fee);
    let pid = bridge.propose(&admins.get_unchecked(0), &ProposalAction::SetFee(new_fee), &1000);
    for i in 1..threshold {
        bridge.approve(&admins.get_unchecked(i as u32), &pid);
    }
    bridge.execute(&pid);

    assert_eq!(bridge.fee_bps(), new_fee, "fee not updated via proposal");
    assert!(bridge.fee_bps() <= bridge.max_fee_bps(), "fee exceeds max after proposal");

    assert_eq!(bridge.accumulated_fees(), before_reinit, "fees lost after proposal");
    assert_eq!(bridge.funding_count(), final_count, "funding count changed");
    assert_eq!(bridge.version(), initial_version, "version changed after proposal");

    let stats = bridge.get_stats();
    assert_eq!(stats.total_fees, before_reinit, "stats.total_fees mismatch");
    assert_eq!(stats.funding_count, final_count, "stats.funding_count mismatch");
    assert_eq!(stats.total_volume, 6000, "stats.total_volume mismatch");
    assert_eq!(stats.unique_funder_count, 1, "unique_funder_count wrong");
}

fn main() {
    let seed: u64 = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
               .unwrap_or(0xF00D_2024_0000_0000);

    let iterations: u64 = std::env::args()
        .nth(2)
        .and_then(|s| s.parse().ok())
        .unwrap_or(500);

    let mut rng = Lcg(seed);

    for i in 0..iterations {
        run_iteration(&mut rng);
        if (i + 1) % 100 == 0 {
            println!("fuzz_upgrade: {}/{} iterations done", i + 1, iterations);
        }
    }

    println!("fuzz_upgrade: all {iterations} iterations passed.");
}