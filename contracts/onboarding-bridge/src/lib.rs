#![no_std]
#![allow(deprecated)]

use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, String, Symbol, Vec};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    FeeBps,
    MaxFeeBps,
    AccumulatedFees,
    Version,
    Paused,
    Admins,
    Threshold,
    ProposalNonce,
    Proposal(u32),
    ProposalApproval(u32, Address),
}

#[contracttype]
#[derive(Clone)]
pub enum ProposalAction {
    SetFee(u32),
    WithdrawFees(Address, Address, i128),
    Pause,
    Unpause,
}

#[contracttype]
#[derive(Clone)]
pub struct Proposal {
    pub id: u32,
    pub action: ProposalAction,
    pub proposer: Address,
    pub approval_count: u32,
    pub executed: bool,
    pub expiry: u32,
}

#[contract]
pub struct OnboardingBridge;

#[contractimpl]
impl OnboardingBridge {
    // ------------------------------------------------------------------------
    // Initialize
    // ------------------------------------------------------------------------

    pub fn initialize(
        env: Env,
        admins: Vec<Address>,
        threshold: u32,
        fee_bps: u32,
        max_fee_bps: u32,
    ) {
        if env.storage().instance().has(&DataKey::Version) {
            panic!("already initialized");
        }
        assert!(!admins.is_empty(), "admins must not be empty");
        assert!(threshold > 0, "threshold must be > 0");
        assert!(threshold <= admins.len(), "threshold exceeds admin count");
        assert!(max_fee_bps <= 10000, "max_fee_bps must be <= 10000");
        assert!(fee_bps <= max_fee_bps, "fee_bps must be <= max_fee_bps");

        env.storage().instance().set(&DataKey::Admins, &admins);
        env.storage()
            .instance()
            .set(&DataKey::Threshold, &threshold);
        env.storage()
            .instance()
            .set(&DataKey::MaxFeeBps, &max_fee_bps);
        env.storage().instance().set(&DataKey::FeeBps, &fee_bps);
        env.storage()
            .instance()
            .set(&DataKey::AccumulatedFees, &0i128);
        env.storage().instance().set(&DataKey::Version, &1u32);
        env.storage().instance().set(&DataKey::Paused, &false);
        env.storage().instance().set(&DataKey::ProposalNonce, &0u32);

        env.events().publish(
            (Symbol::new(&env, "initialize"),),
            (admins, threshold, fee_bps, max_fee_bps),
        );
    }

    // ------------------------------------------------------------------------
    // View functions
    // ------------------------------------------------------------------------

    pub fn version(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::Version).unwrap_or(0)
    }

    pub fn fee_bps(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::FeeBps).unwrap_or(0)
    }

    pub fn max_fee_bps(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::MaxFeeBps)
            .unwrap_or(0)
    }

    pub fn accumulated_fees(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::AccumulatedFees)
            .unwrap_or(0)
    }

    pub fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    pub fn get_admins(env: Env) -> Vec<Address> {
        env.storage()
            .instance()
            .get(&DataKey::Admins)
            .expect("not initialized")
    }

    pub fn get_threshold(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::Threshold)
            .expect("not initialized")
    }

    // ------------------------------------------------------------------------
    // Core operations
    // ------------------------------------------------------------------------

    pub fn fund_c_address(
        env: Env,
        source: Address,
        target: Address,
        _token_address: Address,
        amount: i128,
        _memo: String,
    ) -> i128 {
        assert!(amount > 0, "amount must be positive");
        if env
            .storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
        {
            panic!("contract is paused");
        }

        let fee_bps: u32 = env.storage().instance().get(&DataKey::FeeBps).unwrap_or(0);
        let fee_amount = if fee_bps > 0 {
            (amount * fee_bps as i128) / 10000
        } else {
            0i128
        };

        if fee_amount > 0 {
            let accumulated: i128 = env
                .storage()
                .instance()
                .get(&DataKey::AccumulatedFees)
                .unwrap_or(0);
            env.storage()
                .instance()
                .set(&DataKey::AccumulatedFees, &(accumulated + fee_amount));
        }

        env.events().publish(
            (Symbol::new(&env, "funded"),),
            (source, target, amount, fee_amount),
        );

        fee_amount
    }

    pub fn route_from_exchange(
        env: Env,
        exchange: Address,
        target: Address,
        token_address: Address,
        amount: i128,
        memo: String,
    ) -> i128 {
        exchange.require_auth();
        assert!(amount > 0, "amount must be positive");
        if env
            .storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
        {
            panic!("contract is paused");
        }

        Self::fund_c_address(env, exchange, target, token_address, amount, memo)
    }

    // ------------------------------------------------------------------------
    // Multisig governance
    // ------------------------------------------------------------------------

    pub fn propose(env: Env, proposer: Address, action: ProposalAction, expiry_blocks: u32) -> u32 {
        proposer.require_auth();

        let admins: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Admins)
            .expect("not initialized");
        assert!(
            is_admin_in_list(&admins, &proposer),
            "only admins can propose"
        );
        assert!(expiry_blocks >= 10, "expiry must be >= 10 blocks");
        assert!(expiry_blocks <= 100_000, "expiry must be <= 100000 blocks");

        let nonce: u32 = env
            .storage()
            .instance()
            .get(&DataKey::ProposalNonce)
            .unwrap_or(0);
        let proposal_id = nonce + 1;
        let current_block = env.ledger().sequence();

        // Auto-approve the proposer
        let approval_key = DataKey::ProposalApproval(proposal_id, proposer.clone());
        env.storage().instance().set(&approval_key, &true);

        let proposal = Proposal {
            id: proposal_id,
            action,
            proposer: proposer.clone(),
            approval_count: 1,
            executed: false,
            expiry: current_block + expiry_blocks,
        };

        env.storage()
            .instance()
            .set(&DataKey::Proposal(proposal_id), &proposal);
        env.storage()
            .instance()
            .set(&DataKey::ProposalNonce, &proposal_id);

        env.events().publish(
            (Symbol::new(&env, "proposed"),),
            (proposal_id, proposer, current_block + expiry_blocks),
        );

        proposal_id
    }

    pub fn approve(env: Env, admin: Address, proposal_id: u32) {
        admin.require_auth();

        let admins: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Admins)
            .expect("not initialized");
        assert!(is_admin_in_list(&admins, &admin), "only admins can approve");

        let mut proposal: Proposal = env
            .storage()
            .instance()
            .get(&DataKey::Proposal(proposal_id))
            .expect("proposal not found");

        assert!(
            env.ledger().sequence() <= proposal.expiry,
            "proposal expired"
        );
        assert!(!proposal.executed, "proposal already executed");

        let approval_key = DataKey::ProposalApproval(proposal_id, admin.clone());
        assert!(
            !env.storage().instance().has(&approval_key),
            "already approved this proposal"
        );
        env.storage().instance().set(&approval_key, &true);

        proposal.approval_count += 1;
        env.storage()
            .instance()
            .set(&DataKey::Proposal(proposal_id), &proposal);

        env.events().publish(
            (Symbol::new(&env, "approved"),),
            (proposal_id, admin, proposal.approval_count),
        );
    }

    pub fn execute(env: Env, proposal_id: u32) -> i128 {
        let threshold: u32 = env
            .storage()
            .instance()
            .get(&DataKey::Threshold)
            .expect("not initialized");

        let proposal: Proposal = env
            .storage()
            .instance()
            .get(&DataKey::Proposal(proposal_id))
            .expect("proposal not found");

        assert!(
            env.ledger().sequence() <= proposal.expiry,
            "proposal expired"
        );
        assert!(!proposal.executed, "proposal already executed");
        assert!(
            proposal.approval_count >= threshold,
            "insufficient approvals"
        );

        let mut executed_proposal = proposal.clone();
        executed_proposal.executed = true;
        env.storage()
            .instance()
            .set(&DataKey::Proposal(proposal_id), &executed_proposal);

        let result = match proposal.action {
            ProposalAction::SetFee(new_fee_bps) => {
                let max_fee: u32 = env
                    .storage()
                    .instance()
                    .get(&DataKey::MaxFeeBps)
                    .expect("not initialized");
                assert!(new_fee_bps <= max_fee, "fee exceeds max_fee_bps");
                env.storage().instance().set(&DataKey::FeeBps, &new_fee_bps);
                env.events()
                    .publish((Symbol::new(&env, "set_fee"),), (new_fee_bps,));
                0i128
            }
            ProposalAction::WithdrawFees(to, token, amount) => {
                let accumulated: i128 = env
                    .storage()
                    .instance()
                    .get(&DataKey::AccumulatedFees)
                    .unwrap_or(0);
                let withdraw_amount = if amount == 0 { accumulated } else { amount };
                assert!(
                    withdraw_amount <= accumulated,
                    "insufficient accumulated fees"
                );
                let remaining = accumulated - withdraw_amount;
                env.storage()
                    .instance()
                    .set(&DataKey::AccumulatedFees, &remaining);
                env.events().publish(
                    (Symbol::new(&env, "withdrawn"),),
                    (to, token, withdraw_amount),
                );
                withdraw_amount
            }
            ProposalAction::Pause => {
                env.storage().instance().set(&DataKey::Paused, &true);
                env.events().publish((Symbol::new(&env, "paused"),), ());
                0i128
            }
            ProposalAction::Unpause => {
                env.storage().instance().set(&DataKey::Paused, &false);
                env.events().publish((Symbol::new(&env, "unpaused"),), ());
                0i128
            }
        };

        env.events()
            .publish((Symbol::new(&env, "executed"),), (proposal_id,));

        result
    }

    pub fn get_proposal(env: Env, proposal_id: u32) -> Proposal {
        env.storage()
            .instance()
            .get(&DataKey::Proposal(proposal_id))
            .expect("proposal not found")
    }

    pub fn get_active_proposals(env: Env) -> Vec<Proposal> {
        let nonce: u32 = env
            .storage()
            .instance()
            .get(&DataKey::ProposalNonce)
            .unwrap_or(0);
        let current_block = env.ledger().sequence();
        let mut active: Vec<Proposal> = Vec::new(&env);

        for i in 1..=nonce {
            if let Some(proposal) = env
                .storage()
                .instance()
                .get::<DataKey, Proposal>(&DataKey::Proposal(i))
            {
                if !proposal.executed && current_block <= proposal.expiry {
                    active.push_back(proposal);
                }
            }
        }

        active
    }
}

fn is_admin_in_list(admins: &Vec<Address>, addr: &Address) -> bool {
    for i in 0..admins.len() {
        if &admins.get_unchecked(i) == addr {
            return true;
        }
    }
    false
}

mod test;
