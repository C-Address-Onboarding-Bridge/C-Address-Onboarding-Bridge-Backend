/// Fuzz random sequences of fund_c_address, batch_fund_c_address,
/// and route_from_exchange calls.
///
/// Invariants checked:
///   1. accumulated_fees == sum of all individual fees returned
///   2. total_volume == sum of all amounts funded
///   3. funding_count == number of individual fundings (batch counts each)
///   4. unique_funder_count is monotonically non-decreasing

use onboarding_bridge::OnboardingBridgeClient;
<<<<<<< Updated upstream
use soroban_sdk::{testutils::Address as _, token, Address, Env, String};
=======
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
    Fund,
    BatchFund,
    RouteFromExchange,
}

fn pick_op(rng: &mut Lcg) -> Op {
    match rng.next_usize_bounded(3) {
        0 => Op::Fund,
        1 => Op::BatchFund,
        _ => Op::RouteFromExchange,
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

    let contract_id = env.register_contract(None, onboarding_bridge::OnboardingBridge);
    let bridge = OnboardingBridgeClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
<<<<<<< Updated upstream
    let mut admins = soroban_sdk::Vec::new(&env);
    admins.push_back(admin);

    let fee_bps = rng.next_u32_bounded(10000);
    let max_fee_bps = fee_bps.saturating_add(rng.next_u32_bounded(10000 - fee_bps));

    bridge.initialize(
        &admins,
        &1u32,  // threshold
        &fee_bps,
        &max_fee_bps,
        &1i128,  // min_amount
        &1_000_000_000i128,  // max_amount
    );
=======
    let mut admins: Vec<Address> = Vec::new(&env);
    admins.push_back(admin.clone());
    bridge.initialize(&admins, &1, &100, &10000, &1, &i128::MAX);
>>>>>>> Stashed changes

    let source = Address::generate(&env);
    let exchange = Address::generate(&env);
    let target = Address::generate(&env);
<<<<<<< Updated upstream

    // Register a real token contract and mint the source account so the
    // contract's token transfer during fund_c_address succeeds. Previously
    // the harness passed a random Address as the token, which caused the
    // contract to hit a missing storage entry (HostError: Error(Storage,
    // MissingValue)) when it tried to move funds.
    let token_admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token_address = token_id.address();
    let token_client = token::StellarAssetClient::new(&env, &token_address);
=======
>>>>>>> Stashed changes

    let token = setup_token(&env, &source, 1_000_000_000);
    let _ = setup_token(&env, &exchange, 1_000_000_000);

    let max_amount: i128 = 1_000_000;
    let mut expected_fees: i128 = 0;
    let mut expected_volume: i128 = 0;
    let mut expected_count: u32 = 0;
    let mut seen_funders: std::collections::HashSet<std::string::String> = std::collections::HashSet::new();

<<<<<<< Updated upstream
    for _ in 0..n_calls {
        let amount = rng.next_i128_bounded(max_amount) + 1; // at least 1
        // Fund the source account with enough balance for this transfer.
        token_client.mint(&source, &amount);
        let memo = String::from_str(&env, "fuzz");
        let fee = bridge.fund_c_address(&source, &target, &token_address, &amount, &memo);
        expected_fees += fee;
=======
    let n_ops = rng.next_usize_bounded(19) + 1;

    for _ in 0..n_ops {
        let op = pick_op(rng);
        let memo = String::from_str(&env, "fuzz");

        match op {
            Op::Fund => {
                let amount = rng.next_i128_bounded(max_amount) + 1;
                let fee = bridge.fund_c_address(&source, &target, &token, &amount, &memo);
                expected_fees += fee;
                expected_volume += amount;
                expected_count += 1;
                let _ = seen_funders.insert(source.to_string().to_string());
            }
            Op::BatchFund => {
                let batch_size = rng.next_usize_bounded(4) + 1;
                let mut targets: Vec<Address> = Vec::new(&env);
                let mut tokens: Vec<Address> = Vec::new(&env);
                let mut amounts: Vec<i128> = Vec::new(&env);
                let mut memos: Vec<String> = Vec::new(&env);

                for _ in 0..batch_size {
                    targets.push_back(Address::generate(&env));
                    tokens.push_back(token.clone());
                    amounts.push_back(rng.next_i128_bounded(max_amount) + 1);
                    memos.push_back(String::from_str(&env, "batch"));
                }

                let (total_fees, count) = bridge.batch_fund_c_address(
                    &source, &targets, &tokens, &amounts, &memos,
                );
                expected_fees += total_fees;
                expected_count += count;

                for i in 0..batch_size {
                    let amt = amounts.get(i as u32).unwrap();
                    expected_volume += amt;
                }
                let _ = seen_funders.insert(source.to_string().to_string());
            }
            Op::RouteFromExchange => {
                let amount = rng.next_i128_bounded(max_amount) + 1;
                let fee = bridge.route_from_exchange(&exchange, &target, &token, &amount, &memo);
                expected_fees += fee;
                expected_volume += amount;
                expected_count += 1;
                let _ = seen_funders.insert(exchange.to_string().to_string());
            }
        }

        let actual_fees = bridge.accumulated_fees();
        assert_eq!(
            actual_fees, expected_fees,
            "accumulated_fees mismatch: got {actual_fees}, expected {expected_fees}"
        );

        let stats = bridge.get_stats();
        assert_eq!(
            stats.total_volume, expected_volume,
            "total_volume mismatch: got {}, expected {expected_volume}",
            stats.total_volume
        );

        assert_eq!(
            stats.funding_count, expected_count,
            "funding_count mismatch: got {}, expected {expected_count}",
            stats.funding_count
        );

        assert!(
            stats.unique_funder_count >= seen_funders.len() as u64,
            "unique_funder_count {} < expected {}",
            stats.unique_funder_count,
            seen_funders.len()
        );
>>>>>>> Stashed changes
    }

    let final_stats = bridge.get_stats();
    assert_eq!(final_stats.total_fees, expected_fees);
    assert_eq!(final_stats.total_volume, expected_volume);
    assert_eq!(final_stats.funding_count, expected_count);
}

fn main() {
    let seed: u64 = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(0x1234567890abcdef);

    let iterations: u64 = std::env::args()
        .nth(2)
        .and_then(|s| s.parse().ok())
        .unwrap_or(1000);

    let mut rng = Lcg(seed);

    for i in 0..iterations {
        run_iteration(&mut rng);
        if (i + 1) % 100 == 0 {
            println!("fuzz_fund_sequence: {}/{} iterations done", i + 1, iterations);
        }
    }

    println!("fuzz_fund_sequence: all {iterations} iterations passed.");
}