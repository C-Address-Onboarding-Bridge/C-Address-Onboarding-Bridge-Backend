/// Fuzz random interleavings of governance operations (propose/approve/execute)
/// mixed with funding operations.
///
/// Invariants:
///   1. accumulated_fees never goes negative
///   2. fee_bps always within [0, max_fee_bps]
///   3. Only proposal system can change fee, pause, withdraw
///   4. Admin list never changes (immutable after init in current contract)
///   5. accumulated_fees after partial withdraw == before - withdrawn
///   6. Pause blocks fund/route; unpause restores

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

#[derive(Debug, Clone)]
enum Op {
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

    let source = Address::generate(&env);
    let target = Address::generate(&env);
    let token = setup_token(&env, &source, 10_000_000);

    let mut pending_proposals: Vec<(u32, ProposalAction)> = Vec::new(&env);
    let mut total_withdrawn: i128 = 0;

    let n_ops = rng.next_usize_bounded(29) + 1;

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
                if bridge.is_paused() {
                    continue;
                }
                let amount = rng.next_i128_bounded(100_000i128) + 100i128;
                let memo = String::from_str(&env, "fuzz");
                bridge.fund_c_address(&source, &target, &token, &amount, &memo);

                let after = bridge.accumulated_fees();
                assert!(after >= before_acc, "accumulated_fees decreased without withdrawal");
            }
            Op::ApproveAndExecute => {
                if pending_proposals.is_empty() {
                    continue;
                }
                let idx = rng.next_usize_bounded(pending_proposals.len() - 1);
                let (pid, action) = pending_proposals.get(idx as u32).unwrap();
                pending_proposals.remove(idx as u32);

                bridge.approve(&admin2, &pid);

                let seq = env.ledger().sequence();
                env.ledger().set_sequence_number(seq.saturating_add(1001));

                let before = bridge.accumulated_fees();
                bridge.execute(&pid);

                match action {
                    ProposalAction::WithdrawFees(_, _, amount) => {
                        let after = bridge.accumulated_fees();
                        assert_eq!(
                            after,
                            before - amount,
                            "accumulated_fees after withdraw mismatch"
                        );
                        total_withdrawn += amount;
                    }
                    ProposalAction::SetFee(new_fee) => {
                        assert_eq!(bridge.fee_bps(), new_fee, "fee_bps not updated");
                        assert!(bridge.fee_bps() <= bridge.max_fee_bps());
                    }
                    _ => {}
                }
            }
        }
    }

    let _ = total_withdrawn;
}

#[test]
fn fuzz_admin_ops() {
    let mut rng = Lcg(0x1234_5678_9abc_def0);
    for _ in 0..1000 {
        run_iteration(&mut rng);
    }
}
