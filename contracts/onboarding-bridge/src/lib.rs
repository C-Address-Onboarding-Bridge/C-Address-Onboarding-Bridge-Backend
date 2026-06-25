//! # Onboarding Bridge — Soroban Smart Contract
//!
//! Routes funds from G-addresses and CEX withdrawals directly into Soroban
//! smart accounts (C-addresses), removing the requirement for users to hold a
//! traditional Stellar account before interacting with Soroban dApps.
//!
//! ## Architecture
//!
//! ```text
//! G-Address / CEX  ──▶  OnboardingBridge  ──▶  C-Address (target)
//!                              │
//!                        fee deducted
//!                              │
//!                       AccumulatedFees
//! ```
//!
//! The contract itself does **not** move tokens; callers perform the actual
//! token transfer off-chain (or via a separate SAC call) and invoke
//! [`OnboardingBridge::fund_c_address`] to record the event and accrue fees.
//!
//! ## Fee Model
//!
//! Fees are expressed in **basis points** (bps), where 1 bps = 0.01 %.
//!
//! ```text
//! fee_amount = floor(amount × fee_bps / 10_000)
//! net_amount = amount − fee_amount
//! ```
//!
//! Fees accumulate in [`DataKey::AccumulatedFees`] and can be withdrawn via
//! `withdraw_fees` (admin, single or multi-recipient) or
//! automatically via `trigger_auto_withdraw` (permissionless,
//! fires when accumulated ≥ threshold).
//!
//! Multi-recipient splits are configured through
//! `set_fee_recipients`; each recipient's share must be
//! given in bps and all shares must sum to exactly 10 000.  The **last**
//! recipient always receives the remainder to absorb integer-division dust.
//!
//! ## Storage Layout
//!
//! All keys live in **instance** storage (contract lifetime):
//!
//! | Key                    | Type            | Description                         |
//! |------------------------|-----------------|-------------------------------------|
//! | `Admin`                | `Address`       | Contract administrator              |
//! | `FeeBps`               | `u32`           | Current fee rate (0–10 000)         |
//! | `AccumulatedFees`      | `i128`          | Total unclaimed fees (stroops)      |
//! | `Version`              | `u32`           | Contract schema version             |
//! | `FeeRecipients`        | `Vec<FeeRecipient>` | Optional multi-recipient split  |
//! | `AutoWithdrawThreshold`| `i128`          | Auto-withdraw trigger level; 0 = off|

#![no_std]
#![allow(deprecated)]
#![allow(clippy::needless_borrows_for_generic_args)]

use soroban_sdk::{
    contract, contractimpl, contracttype, crypto::Hash, token, Address, Bytes, BytesN, Env, String,
    Symbol, Vec,
};

const TTL_THRESHOLD: u32 = 5000;
const TTL_EXTEND: u32 = 50000;

const ERR_INVALID_C_ADDRESS: &str = "invalid c-address: not a contract address";
const ERR_REENTRANT_CALL: &str = "reentrant call detected";
const ERR_EMPTY_BATCH: &str = "batch inputs must not be empty";
const ERR_MISMATCHED_LENGTHS: &str = "batch input vectors must have same length";
const ERR_NO_ENTRIES_TO_ARCHIVE: &str = "no entries to archive";

/// Storage keys used throughout the contract.
///
/// Every variant maps to a distinct slot in instance storage.
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    FeeBps,
    MaxFeeBps,
    AccumulatedFees,
    /// Logical contract version (user-visible, incremented on each upgrade).
    Version,
    Paused,
    Admins,
    Threshold,
    ProposalNonce,
    Proposal(u32),
    ProposalApproval(u32, Address),
    ReentrancyGuard,
    Funding(u32),
    FundingCount,
    ArchivedHash(u32),
    NextArchiveId,
    MinAmount,
    MaxAmount,
    UserVolume(Address),
    TierThreshold(u32),
    TierDiscount(u32),
    TierCount,
}

#[contracttype]
#[derive(Clone)]
pub struct FundingRecord {
    source: Address,
    target: Address,
    token_address: Address,
    amount: i128,
    fee: i128,
    ledger: u32,
    memo: String,
    archived: bool,
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

fn rebate_bps(env: &Env, user: &Address) -> u32 {
    let volume: i128 = env
        .storage()
        .instance()
        .get(&DataKey::UserVolume(user.clone()))
        .unwrap_or(0);
    let tier_count: u32 = env
        .storage()
        .instance()
        .get(&DataKey::TierCount)
        .unwrap_or(0);
    let mut best: u32 = 0;
    for i in 0..tier_count {
        let threshold: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TierThreshold(i))
            .unwrap_or(0);
        let discount: u32 = env
            .storage()
            .instance()
            .get(&DataKey::TierDiscount(i))
            .unwrap_or(0);
        if volume >= threshold && discount > best {
            best = discount;
        }
    }
    best
}

#[contractimpl]
impl OnboardingBridge {
    fn is_contract_address(addr: &Address) -> bool {
        let s = addr.to_string();
        let bytes = s.to_bytes();
        bytes.first() == Some(b'C')
    }

    fn validate_c_address(target: &Address) {
        if !Self::is_contract_address(target) {
            panic!("{}", ERR_INVALID_C_ADDRESS);
        }
    }

    pub fn is_valid_c_address(_env: Env, target: Address) -> bool {
        Self::is_contract_address(&target)
    }

    fn pre_reentrancy_check(env: &Env) {
        if env.storage().temporary().has(&DataKey::ReentrancyGuard) {
            panic!("{}", ERR_REENTRANT_CALL);
        }
    }

    fn set_reentrancy_guard(env: &Env) {
        env.storage()
            .temporary()
            .set(&DataKey::ReentrancyGuard, &true);
    }

    fn clear_reentrancy_guard(env: &Env) {
        env.storage().temporary().remove(&DataKey::ReentrancyGuard);
    }

    fn extend_ttl(env: &Env) {
        env.storage()
            .instance()
            .extend_ttl(TTL_THRESHOLD, TTL_EXTEND);
    }

    pub fn initialize(
        env: Env,
        admins: Vec<Address>,
        threshold: u32,
        fee_bps: u32,
        max_fee_bps: u32,
        min_amount: i128,
        max_amount: i128,
    ) {
        if env.storage().instance().has(&DataKey::Version) {
            panic!("already initialized");
        }
        assert!(!admins.is_empty(), "admins must not be empty");
        assert!(threshold > 0, "threshold must be > 0");
        assert!(threshold <= admins.len(), "threshold exceeds admin count");
        assert!(max_fee_bps <= 10000, "max_fee_bps must be <= 10000");
        assert!(fee_bps <= max_fee_bps, "fee_bps must be <= max_fee_bps");
        assert!(min_amount > 0, "min_amount must be > 0");
        assert!(max_amount >= min_amount, "max_amount must be >= min_amount");

        env.storage().instance().set(&DataKey::Admins, &admins);
        env.storage()
            .instance()
            .set(&DataKey::Threshold, &threshold);
        env.storage()
            .instance()
            .set(&DataKey::MaxFeeBps, &max_fee_bps);
        env.storage().instance().set(&DataKey::FeeBps, &fee_bps);
        env.storage().instance().set(&DataKey::AccumulatedFees, &0i128);
        env.storage().instance().set(&DataKey::Version, &1u32);
        env.storage().instance().set(&DataKey::FundingCount, &0u32);
        env.storage().instance().set(&DataKey::NextArchiveId, &0u32);
        env.storage().instance().set(&DataKey::Paused, &false);
        env.storage().instance().set(&DataKey::ProposalNonce, &0u32);
        env.storage()
            .instance()
            .set(&DataKey::MinAmount, &min_amount);
        env.storage()
            .instance()
            .set(&DataKey::MaxAmount, &max_amount);

        env.events().publish(
            (Symbol::new(&env, "initialize"),),
            (
                admins,
                threshold,
                fee_bps,
                max_fee_bps,
                min_amount,
                max_amount,
            ),
        );
    }

    // -----------------------------------------------------------------------
    // Getters
    // -----------------------------------------------------------------------

    pub fn version(env: Env) -> u32 {
        Self::extend_ttl(&env);
        env.storage().instance().get(&DataKey::Version).unwrap_or(0)
    }

    pub fn fee_bps(env: Env) -> u32 {
        Self::extend_ttl(&env);
        env.storage().instance().get(&DataKey::FeeBps).unwrap_or(0)
    }

    pub fn max_fee_bps(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::MaxFeeBps)
            .unwrap_or(0)
    }

    pub fn min_amount(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::MinAmount)
            .unwrap_or(1)
    }

    pub fn max_amount(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::MaxAmount)
            .unwrap_or(i128::MAX)
    }

    pub fn user_volume(env: Env, user: Address) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::UserVolume(user))
            .unwrap_or(0)
    }

    pub fn rebate_for(env: Env, user: Address) -> u32 {
        rebate_bps(&env, &user)
    }

    /// Returns the total unclaimed fees accumulated in the contract (stroops).
    ///
    /// # Returns
    ///
    /// Running fee balance as `i128`, or `0` if none have been collected.
    ///
    /// # Examples
    ///
    /// ```ignore
    /// let fees = contract.accumulated_fees(env);
    /// ```
    pub fn accumulated_fees(env: Env) -> i128 {
        Self::extend_ttl(&env);
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

    pub fn set_rebate_tier(env: Env, tier_index: u32, threshold: i128, discount_bps: u32) {
        let admins: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Admins)
            .expect("not initialized");
        admins.get_unchecked(0).require_auth();
        assert!(discount_bps <= 5000, "discount capped at 50%");
        env.storage()
            .instance()
            .set(&DataKey::TierThreshold(tier_index), &threshold);
        env.storage()
            .instance()
            .set(&DataKey::TierDiscount(tier_index), &discount_bps);
        let count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::TierCount)
            .unwrap_or(0);
        if tier_index >= count {
            env.storage()
                .instance()
                .set(&DataKey::TierCount, &(tier_index + 1));
        }
        env.events().publish(
            (Symbol::new(&env, "tier_set"),),
            (tier_index, threshold, discount_bps),
        );
    }

    pub fn fund_c_address(
        env: Env,
        source: Address,
        target: Address,
        token_address: Address,
        amount: i128,
        memo: String,
    ) -> i128 {
        Self::extend_ttl(&env);
        Self::pre_reentrancy_check(&env);
        Self::validate_c_address(&target);
        assert!(amount > 0, "amount must be positive");
        if env
            .storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
        {
            panic!("contract is paused");
        }
        Self::set_reentrancy_guard(&env);
        let result =
            Self::fund_c_address_internal(&env, &source, &target, &token_address, amount, &memo);
        Self::clear_reentrancy_guard(&env);
        result
    }

    fn fund_c_address_internal(
        env: &Env,
        source: &Address,
        target: &Address,
        token_address: &Address,
        amount: i128,
        memo: &String,
    ) -> i128 {
        let min_amt: i128 = env
            .storage()
            .instance()
            .get(&DataKey::MinAmount)
            .unwrap_or(1);
        let max_amt: i128 = env
            .storage()
            .instance()
            .get(&DataKey::MaxAmount)
            .unwrap_or(i128::MAX);
        assert!(amount >= min_amt, "amount below minimum");
        assert!(amount <= max_amt, "amount above maximum");

        let fee_bps: u32 = env.storage().instance().get(&DataKey::FeeBps).unwrap_or(0);
        let discount = rebate_bps(env, source);
        let effective_fee_bps = fee_bps.saturating_sub(fee_bps * discount / 10000);
        let fee = if effective_fee_bps > 0 {
            (amount * effective_fee_bps as i128) / 10000
        } else {
            0i128
        };

        let net_amount = amount - fee;
        let tk = token::Client::new(env, token_address);
        tk.transfer(source, &env.current_contract_address(), &amount);
        if fee > 0 {
            let accumulated: i128 = env
                .storage()
                .instance()
                .get(&DataKey::AccumulatedFees)
                .unwrap_or(0);
            env.storage()
                .instance()
                .set(&DataKey::AccumulatedFees, &(accumulated + fee));
        }
        tk.transfer(&env.current_contract_address(), target, &net_amount);

        let vol_key = DataKey::UserVolume(source.clone());
        let vol: i128 = env.storage().instance().get(&vol_key).unwrap_or(0);
        env.storage().instance().set(&vol_key, &(vol + amount));

        let count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::FundingCount)
            .unwrap_or(0);
        let id = count + 1;
        let record = FundingRecord {
            source: source.clone(),
            target: target.clone(),
            token_address: token_address.clone(),
            amount,
            fee,
            ledger: env.ledger().sequence(),
            memo: memo.clone(),
            archived: false,
        };
        env.storage()
            .persistent()
            .set(&DataKey::Funding(id), &record);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Funding(id), TTL_THRESHOLD, TTL_EXTEND);
        env.storage().instance().set(&DataKey::FundingCount, &id);

        env.events().publish(
            (Symbol::new(env, "funded"),),
            (source.clone(), target.clone(), amount, fee, discount),
        );

        fee
    }

    pub fn batch_fund_c_address(
        env: Env,
        source: Address,
        targets: Vec<Address>,
        token_addresses: Vec<Address>,
        amounts: Vec<i128>,
        memos: Vec<String>,
    ) -> (i128, u32) {
        Self::extend_ttl(&env);
        Self::pre_reentrancy_check(&env);
        source.require_auth();

        let count = targets.len();
        assert!(count > 0, "{}", ERR_EMPTY_BATCH);
        assert!(
            token_addresses.len() == count && amounts.len() == count && memos.len() == count,
            "{}",
            ERR_MISMATCHED_LENGTHS
        );

        for i in 0..count {
            Self::validate_c_address(&targets.get(i).unwrap());
        }

        Self::set_reentrancy_guard(&env);

        let mut total_fees: i128 = 0;
        for i in 0..count {
            let target = targets.get(i).unwrap();
            let token_addr = token_addresses.get(i).unwrap();
            let amount = amounts.get(i).unwrap();
            let memo = memos.get(i).unwrap();
            total_fees +=
                Self::fund_c_address_internal(&env, &source, &target, &token_addr, amount, &memo);
        }

        env.events().publish(
            (Symbol::new(&env, "batch_funded"),),
            (source, count, total_fees),
        );

        Self::clear_reentrancy_guard(&env);
        (total_fees, count)
    }

    /// Route a CEX withdrawal to a C-address.
    ///
    /// Convenience wrapper around `fund_c_address` that requires the calling
    /// exchange address to authorise the transaction, then delegates all fee
    /// logic and event emission to `fund_c_address`.
    ///
    /// # Parameters
    ///
    /// - `exchange` — Authorised exchange address initiating the withdrawal.
    /// - `target` — Destination C-address.
    /// - `token_address` — Token being transferred.
    /// - `amount` — Gross transfer amount.
    /// - `memo` — Memo for off-chain tracking (format: `bridge:{exchange}:{suffix}`).
    ///
    /// # Returns
    ///
    /// Fee amount deducted (see `fund_c_address`).
    ///
    /// # Panics
    ///
    /// - Auth failure — if the transaction is not signed by `exchange`.
    ///
    /// # Events
    ///
    /// Emits `("funded",) → (exchange, target, amount, fee_amount)` (via `fund_c_address`).
    ///
    /// # Examples
    ///
    /// ```ignore
    /// let fee = contract.route_from_exchange(env, exchange, target, token, 10_000_000, memo);
    /// ```
    pub fn route_from_exchange(
        env: Env,
        exchange: Address,
        target: Address,
        token_address: Address,
        amount: i128,
        memo: String,
    ) -> i128 {
        Self::extend_ttl(&env);
        Self::pre_reentrancy_check(&env);
        Self::validate_c_address(&target);
        assert!(amount > 0, "amount must be positive");
        if env
            .storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
        {
            panic!("contract is paused");
        }
        exchange.require_auth();
        Self::fund_c_address_internal(&env, &exchange, &target, &token_address, amount, &memo)
    }

    pub fn funding_count(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::FundingCount)
            .unwrap_or(0)
    }

    pub fn funding_record(env: Env, id: u32) -> Option<FundingRecord> {
        env.storage().persistent().get(&DataKey::Funding(id))
    }

    pub fn archive_old_entries(env: Env, count: u32) -> BytesN<32> {
        let admins: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Admins)
            .expect("not initialized");
        if !admins.is_empty() {
            admins.get_unchecked(0).require_auth();
        }
        Self::extend_ttl(&env);

        let total: u32 = env
            .storage()
            .instance()
            .get(&DataKey::FundingCount)
            .unwrap_or(0);
        let archive_count = if count > total { total } else { count };
        assert!(archive_count > 0, "{}", ERR_NO_ENTRIES_TO_ARCHIVE);

        let mut buf: Vec<i128> = Vec::new(&env);
        for i in 1..=archive_count {
            if let Some(mut record) = env
                .storage()
                .persistent()
                .get::<DataKey, FundingRecord>(&DataKey::Funding(i))
            {
                record.archived = true;
                buf.push_back(record.amount);
                buf.push_back(record.fee);
                env.storage()
                    .persistent()
                    .set(&DataKey::Funding(i), &record);
            }
        }

        let archive_id: u32 = env
            .storage()
            .instance()
            .get(&DataKey::NextArchiveId)
            .unwrap_or(0);

        let mut hash_bytes = Bytes::new(&env);
        for i in 0..buf.len() {
            let val = buf.get(i).unwrap();
            let byte: u8 = (val & 0xFF) as u8;
            hash_bytes.push_back(byte);
        }
        let hash: Hash<32> = env.crypto().sha256(&hash_bytes);
        let hash_val: BytesN<32> = hash.to_bytes();

        env.storage()
            .persistent()
            .set(&DataKey::ArchivedHash(archive_id), &hash_val);
        env.storage().persistent().extend_ttl(
            &DataKey::ArchivedHash(archive_id),
            TTL_THRESHOLD,
            TTL_EXTEND,
        );
        env.storage()
            .instance()
            .set(&DataKey::NextArchiveId, &(archive_id + 1));

        env.events().publish(
            (Symbol::new(&env, "archived"),),
            (archive_count, hash_val.clone()),
        );

        hash_val
    }

    pub fn storage_usage(env: Env) -> (u32, u32, i128, u32) {
        let funding_count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::FundingCount)
            .unwrap_or(0);
        let archived_count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::NextArchiveId)
            .unwrap_or(0);
        let accumulated_fees: i128 = env
            .storage()
            .instance()
            .get(&DataKey::AccumulatedFees)
            .unwrap_or(0);
        (funding_count, archived_count, accumulated_fees, 5u32)
    }

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
                let tk = token::Client::new(&env, &token);
                tk.transfer(&env.current_contract_address(), &to, &withdraw_amount);
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
