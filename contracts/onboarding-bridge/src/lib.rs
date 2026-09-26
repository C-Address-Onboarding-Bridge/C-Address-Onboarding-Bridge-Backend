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
#![allow(clippy::needless_borrows_for_generic_args)]

use soroban_sdk::{
    contract, contractevent, contractimpl, contracttype, crypto::Hash, token, Address, Bytes,
    BytesN, Env, String, Vec,
};

// At five seconds per ledger, retain contract configuration and records for
// roughly 30 days before renewal, and renew them for roughly 90 days.
const INSTANCE_TTL_THRESHOLD: u32 = 518_400;
const INSTANCE_TTL_EXTEND: u32 = 1_555_200;
const PERSISTENT_TTL_THRESHOLD: u32 = 518_400;
const PERSISTENT_TTL_EXTEND: u32 = 1_555_200;
const TTL_THRESHOLD: u32 = PERSISTENT_TTL_THRESHOLD;
const TTL_EXTEND: u32 = PERSISTENT_TTL_EXTEND;
/// Minimum ledgers that must elapse between `propose` and `execute` for
/// sensitive actions (WithdrawFees, SetFee, Pause). Prevents a single admin
/// with threshold == 1 from proposing and immediately executing with no
/// transparency window.
const MIN_EXEC_DELAY: u32 = 10;
/// Maximum amount that can be passed to fund_c_address. Ensures the fee
/// multiplication `amount * effective_fee_bps` never overflows i128.
/// i128::MAX / 10_000 ≈ 1.7 × 10^34, far above any realistic token amount.
const MAX_SAFE_AMOUNT: i128 = i128::MAX / 10_000;
/// Maximum number of rebate tiers an admin may register. `rebate_bps` scans
/// every tier on each funding call, so this bounds that cost regardless of
/// how many `set_rebate_tier` calls have ever been made.
const MAX_TIERS: u32 = 50;
/// Maximum memo size stored in each funding record, in bytes.
const MAX_MEMO_BYTES: u32 = 64;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum BridgeError {
    NotInitialized = 1,
    AdminsEmpty = 2,
    ThresholdZero = 3,
    ThresholdExceedsAdminCount = 4,
    MaxFeeExceedsLimit = 5,
    FeeExceedsMaxFee = 6,
    MinAmountInvalid = 7,
    MaxAmountBelowMinimum = 8,
    AdminCannotBeContract = 9,
    InvalidCAddress = 10,
    AmountNotPositive = 11,
    ContractPaused = 12,
    AmountBelowMinimum = 13,
    AmountAboveMaximum = 14,
    AmountTooLarge = 15,
    ReentrantCall = 16,
    EmptyBatch = 17,
    MismatchedBatchLengths = 18,
    NoEntriesToArchive = 19,
    OnlyAdminsCanPropose = 20,
    ExpiryTooShort = 21,
    ExpiryTooLong = 22,
    OnlyAdminsCanApprove = 23,
    ProposalNotFound = 24,
    ProposalExpired = 25,
    ProposalAlreadyExecuted = 26,
    AlreadyApproved = 27,
    InsufficientApprovals = 28,
    ExecutionTooSoon = 29,
    RateBelowMinimum = 30,
    RateAboveMaximum = 31,
    InsufficientAccumulatedFees = 32,
    DiscountTooHigh = 33,
    TierCapExceeded = 34,
}

#[contractevent(topics = ["initialize"], data_format = "vec")]
#[derive(Clone)]
pub struct Initialized {
    pub admins: Vec<Address>,
    pub threshold: u32,
    pub fee_bps: u32,
    pub max_fee_bps: u32,
    pub min_amount: i128,
    pub max_amount: i128,
}

#[contractevent(topics = ["funded"], data_format = "vec")]
#[derive(Clone)]
pub struct Funded {
    #[topic]
    pub source: Address,
    #[topic]
    pub target: Address,
    #[topic]
    pub token: Address,
    pub amount: i128,
    pub fee: i128,
    pub discount: u32,
}

#[contractevent(topics = ["batch_funded"], data_format = "vec")]
#[derive(Clone)]
pub struct BatchFunded {
    #[topic]
    pub source: Address,
    pub count: u32,
    pub total_fees: i128,
}

#[contractevent(topics = ["archived"], data_format = "vec")]
#[derive(Clone)]
pub struct Archived {
    pub archive_count: u32,
    pub hash: BytesN<32>,
}

#[contractevent(topics = ["proposed"], data_format = "vec")]
#[derive(Clone)]
pub struct Proposed {
    pub proposal_id: u32,
    pub proposer: Address,
    pub expiry: u32,
}

#[contractevent(topics = ["approved"], data_format = "vec")]
#[derive(Clone)]
pub struct Approved {
    pub proposal_id: u32,
    pub admin: Address,
    pub approval_count: u32,
}

#[contractevent(topics = ["set_fee"], data_format = "vec")]
#[derive(Clone)]
pub struct SetFee {
    pub fee_bps: u32,
}

#[contractevent(topics = ["set_fee_token_whitelist"], data_format = "vec")]
#[derive(Clone)]
pub struct SetFeeTokenWhitelist {
    #[topic]
    pub token: Address,
    pub enabled: bool,
}

#[contractevent(topics = ["set_fee_token_rate"], data_format = "vec")]
#[derive(Clone)]
pub struct SetFeeTokenRate {
    #[topic]
    pub token: Address,
    pub rate: u32,
}

#[contractevent(topics = ["withdrawn"], data_format = "vec")]
#[derive(Clone)]
pub struct Withdrawn {
    pub to: Address,
    #[topic]
    pub token: Address,
    pub amount: i128,
}

#[contractevent(topics = ["paused"])]
#[derive(Clone)]
pub struct Paused;

#[contractevent(topics = ["unpaused"])]
#[derive(Clone)]
pub struct Unpaused;

#[contractevent(topics = ["admins_rotated"], data_format = "vec")]
#[derive(Clone)]
pub struct AdminsRotated {
    pub admins: Vec<Address>,
}

#[contractevent(topics = ["threshold_set"], data_format = "vec")]
#[derive(Clone)]
pub struct ThresholdSet {
    pub threshold: u32,
}

#[contractevent(topics = ["tier_set"], data_format = "vec")]
#[derive(Clone)]
pub struct TierSet {
    pub tier_index: u32,
    pub threshold: i128,
    pub discount_bps: u32,
}

#[contractevent(topics = ["executed"], data_format = "vec")]
#[derive(Clone)]
pub struct Executed {
    pub proposal_id: u32,
}

#[contractevent(topics = ["proposals_pruned"], data_format = "vec")]
#[derive(Clone)]
pub struct ProposalsPruned {
    pub pruned: u32,
    pub cursor: u32,
}

/// Storage keys used throughout the contract.
///
/// Every variant maps to a distinct storage slot.
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
    InitializationParams,
    FeeTokenWhitelist(Address),
    FeeTokenRate(Address),
    AccumulatedFeesByToken(Address),
    Threshold,
    ProposalNonce,
    Proposal(u32),
    ProposalApproval(u32, Address),
    ActiveProposalIds,
    NextPruneId,
    ReentrancyGuard,
    Funding(u32),
    FundingCount,
    HotCount,
    ArchivedHash(u32),
    NextArchiveId,
    NextArchiveRecordId,
    ExecutionDelay,
    MinAmount,
    MaxAmount,
    UserVolume(Address, Address),
    TierThreshold(u32),
    TierDiscount(u32),
    TierCount,
    // #20: analytics counters
    TotalVolume,
    /// Per-token volume tracking to handle multi-currency environments.
    /// Only use this; TotalVolume is deprecated when multiple tokens are active.
    TotalVolumeByToken(Address),
    UniqueFunder(Address),
    UniqueFunderCount,
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
    SetFeeTokenWhitelist(Address, bool),
    SetFeeTokenRate(Address, u32),
    WithdrawFees(Address, Address, i128),
    Pause,
    Unpause,
    /// Replaces the entire admin set. The current threshold must still be
    /// satisfiable by the new admin count, or execution panics.
    RotateAdmins(Vec<Address>),
    /// Changes the multisig approval threshold. Must be > 0 and <= the
    /// current admin count.
    SetThreshold(u32),
    /// Archives old funding entries up to the specified count.
    ArchiveOldEntries(u32),
    SetRebateTier(u32, i128, u32),
}

#[contracttype]
#[derive(Clone)]
pub struct InitializationParams {
    pub threshold: u32,
    pub fee_bps: u32,
    pub max_fee_bps: u32,
    pub admin_count: u32,
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
    /// Ledger sequence at which the proposal was created. Used to enforce
    /// the minimum execution delay for sensitive actions.
    pub proposed_at: u32,
}

/// #20: Batch analytics view returned by `get_stats`.
///
/// **Warning**: When multiple token types are active, `total_volume` and `total_fees`
/// become meaningless as they mix units from different tokens. Use
/// `total_volume_for_token(token)` and `accumulated_fees_for_token(token)` instead
/// for per-token metrics.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct Stats {
    pub total_volume: i128,
    pub total_fees: i128,
    pub funding_count: u32,
    pub unique_funder_count: u64,
}

#[contract]
pub struct OnboardingBridge;

fn rebate_bps(env: &Env, user: &Address, token: &Address) -> u32 {
    let volume: i128 = env
        .storage()
        .persistent()
        .get(&DataKey::UserVolume(user.clone(), token.clone()))
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
            .persistent()
            .get(&DataKey::TierThreshold(i))
            .unwrap_or(0);
        let discount: u32 = env
            .storage()
            .persistent()
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

    fn validate_c_address(target: &Address) -> Result<(), BridgeError> {
        if !Self::is_contract_address(target) {
            return Err(BridgeError::InvalidCAddress);
        }
        Ok(())
    }

    fn validate_admins(env: &Env, admins: &Vec<Address>) -> Result<(), BridgeError> {
        let contract_address = env.current_contract_address();
        for i in 0..admins.len() {
            let admin = admins.get_unchecked(i);
            if admin == contract_address {
                return Err(BridgeError::AdminCannotBeContract);
            }
        }
        Ok(())
    }

    pub fn is_valid_c_address(_env: Env, target: Address) -> bool {
        Self::is_contract_address(&target)
    }

    fn pre_reentrancy_check(env: &Env) -> Result<(), BridgeError> {
        if env.storage().temporary().has(&DataKey::ReentrancyGuard) {
            return Err(BridgeError::ReentrantCall);
        }
        Ok(())
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
            .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);
    }

    fn extend_persistent_ttl<K: soroban_sdk::IntoVal<Env, soroban_sdk::Val>>(
        env: &Env,
        key: &K,
    ) {
        env.storage()
            .persistent()
            .extend_ttl(key, PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND);
    }

    pub fn initialize(
        env: Env,
        admins: Vec<Address>,
        threshold: u32,
        fee_bps: u32,
        max_fee_bps: u32,
        min_amount: i128,
        max_amount: i128,
    ) -> Result<(), BridgeError> {
        if env.storage().instance().has(&DataKey::Version) {
            return Ok(());
        }
        if admins.is_empty() {
            return Err(BridgeError::AdminsEmpty);
        }
        if threshold == 0 {
            return Err(BridgeError::ThresholdZero);
        }
        if threshold > admins.len() {
            return Err(BridgeError::ThresholdExceedsAdminCount);
        }
        if max_fee_bps > 10000 {
            return Err(BridgeError::MaxFeeExceedsLimit);
        }
        if fee_bps > max_fee_bps {
            return Err(BridgeError::FeeExceedsMaxFee);
        }
        if min_amount <= 0 {
            return Err(BridgeError::MinAmountInvalid);
        }
        if max_amount < min_amount {
            return Err(BridgeError::MaxAmountBelowMinimum);
        }

        Self::validate_admins(&env, &admins)?;

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
        env.storage().instance().set(
            &DataKey::InitializationParams,
            &InitializationParams {
                threshold,
                fee_bps,
                max_fee_bps,
                admin_count: admins.len(),
            },
        );
        env.storage().instance().set(&DataKey::FundingCount, &0u32);
        env.storage().instance().set(&DataKey::HotCount, &0u32);
        env.storage().instance().set(&DataKey::NextArchiveId, &0u32);
        env.storage().instance().set(&DataKey::NextArchiveRecordId, &1u32);
        env.storage()
            .instance()
            .set(&DataKey::ExecutionDelay, &execution_delay);
        env.storage().instance().set(&DataKey::Paused, &false);
        env.storage().instance().set(&DataKey::ProposalNonce, &0u32);
        env.storage()
            .instance()
            .set(&DataKey::ActiveProposalIds, &Vec::<u32>::new(&env));
        env.storage().instance().set(&DataKey::NextPruneId, &1u32);
        env.storage()
            .instance()
            .set(&DataKey::MinAmount, &min_amount);
        env.storage()
            .instance()
            .set(&DataKey::MaxAmount, &max_amount);
        // #20: analytics counters
        env.storage().instance().set(&DataKey::TotalVolume, &0i128);
        env.storage()
            .instance()
            .set(&DataKey::UniqueFunderCount, &0u64);
        Self::extend_ttl(&env);

        Initialized {
            admins,
            threshold,
            fee_bps,
            max_fee_bps,
            min_amount,
            max_amount,
        }
        .publish(&env);
    }

    // -----------------------------------------------------------------------
    // Getters
    // -----------------------------------------------------------------------

    pub fn version(env: Env) -> u32 {
        Self::extend_ttl(&env);
        env.storage().instance().get(&DataKey::Version).unwrap_or(0)
    }

    pub fn contract_address(env: Env) -> Address {
        env.current_contract_address()
    }

    pub fn initialization_params(env: Env) -> InitializationParams {
        Self::extend_ttl(&env);
        env.storage()
            .instance()
            .get(&DataKey::InitializationParams)
            .unwrap_or(InitializationParams {
                threshold: 0,
                fee_bps: 0,
                max_fee_bps: 0,
                admin_count: 0,
            })
    }

    pub fn fee_bps(env: Env) -> u32 {
        Self::extend_ttl(&env);
        env.storage().instance().get(&DataKey::FeeBps).unwrap_or(0)
    }

    pub fn is_fee_token_whitelisted(env: Env, token_address: Address) -> bool {
        Self::extend_ttl(&env);
        env.storage()
            .persistent()
            .get(&DataKey::FeeTokenWhitelist(token_address))
            .unwrap_or(false)
    }

    pub fn fee_token_rate(env: Env, token_address: Address) -> u32 {
        Self::extend_ttl(&env);
        env.storage()
            .persistent()
            .get(&DataKey::FeeTokenRate(token_address))
            .unwrap_or(10000)
    }

    pub fn accumulated_fees_for_token(env: Env, token_address: Address) -> i128 {
        Self::extend_ttl(&env);
        env.storage()
            .instance()
            .get(&DataKey::AccumulatedFeesByToken(token_address))
            .unwrap_or(0)
    }

    /// Returns the total volume funded for a specific token.
    /// Use this instead of accumulated_fees() when operating with multiple token types.
    pub fn total_volume_for_token(env: Env, token_address: Address) -> i128 {
        Self::extend_ttl(&env);
        env.storage()
            .persistent()
            .get(&DataKey::TotalVolumeByToken(token_address))
            .unwrap_or(0)
    }

    pub fn max_fee_bps(env: Env) -> u32 {
        Self::extend_ttl(&env);
        env.storage()
            .instance()
            .get(&DataKey::MaxFeeBps)
            .unwrap_or(0)
    }

    pub fn min_amount(env: Env) -> i128 {
        Self::extend_ttl(&env);
        env.storage()
            .instance()
            .get(&DataKey::MinAmount)
            .unwrap_or(1)
    }

    pub fn max_amount(env: Env) -> i128 {
        Self::extend_ttl(&env);
        env.storage()
            .instance()
            .get(&DataKey::MaxAmount)
            .unwrap_or(i128::MAX)
    }

    pub fn user_volume(env: Env, user: Address, token: Address) -> i128 {
        Self::extend_ttl(&env);
        env.storage()
            .persistent()
            .get(&DataKey::UserVolume(user, token))
            .unwrap_or(0)
    }

    pub fn rebate_for(env: Env, user: Address, token: Address) -> u32 {
        Self::extend_ttl(&env);
        rebate_bps(&env, &user, &token)
    }

    /// Returns the total unclaimed fees accumulated in the contract (stroops).
    ///
    /// **⚠️ Warning**: When multiple token types are active, this value is a mixed-unit sum
    /// and becomes meaningless. Use `accumulated_fees_for_token(token)` for per-token metrics.
    pub fn accumulated_fees(env: Env) -> i128 {
        Self::extend_ttl(&env);
        env.storage()
            .instance()
            .get(&DataKey::AccumulatedFees)
            .unwrap_or(0)
    }

    pub fn is_paused(env: Env) -> bool {
        Self::extend_ttl(&env);
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    pub fn get_admins(env: Env) -> Vec<Address> {
        Self::extend_ttl(&env);
        env.storage()
            .instance()
            .get(&DataKey::Admins)
            .ok_or(BridgeError::NotInitialized)
    }

    pub fn get_threshold(env: Env) -> u32 {
        Self::extend_ttl(&env);
        env.storage()
            .instance()
            .get(&DataKey::Threshold)
            .ok_or(BridgeError::NotInitialized)
    }

    /// #20: Batch analytics view — returns all counters in one call.
    pub fn get_stats(env: Env) -> Stats {
        Self::extend_ttl(&env);
        Stats {
            total_volume: env
                .storage()
                .instance()
                .get(&DataKey::TotalVolume)
                .unwrap_or(0),
            total_fees: env
                .storage()
                .instance()
                .get(&DataKey::AccumulatedFees)
                .unwrap_or(0),
            funding_count: env
                .storage()
                .instance()
                .get(&DataKey::FundingCount)
                .unwrap_or(0),
            unique_funder_count: env
                .storage()
                .instance()
                .get(&DataKey::UniqueFunderCount)
                .unwrap_or(0),
        }
    }

    pub fn fund_c_address(
        env: Env,
        source: Address,
        target: Address,
        token_address: Address,
        amount: i128,
        memo: String,
    ) -> Result<i128, BridgeError> {
        Self::extend_ttl(&env);
        Self::pre_reentrancy_check(&env)?;
        Self::validate_c_address(&target)?;
        if amount <= 0 {
            return Err(BridgeError::AmountNotPositive);
        }
        if env
            .storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
        {
            return Err(BridgeError::ContractPaused);
        }
        Self::set_reentrancy_guard(&env);
        let result = Self::fund_c_address_internal(
            &env, &source, &target, &token_address, amount, &memo,
        )?;
        Self::clear_reentrancy_guard(&env);
        Ok(result)
    }

    fn fund_c_address_internal(
        env: &Env,
        source: &Address,
        target: &Address,
        token_address: &Address,
        amount: i128,
        memo: &String,
    ) -> Result<i128, BridgeError> {
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
        if amount < min_amt {
            return Err(BridgeError::AmountBelowMinimum);
        }
        if amount > max_amt {
            return Err(BridgeError::AmountAboveMaximum);
        }
        // Guard: amount must not overflow the fee multiplication.
        assert!(
            amount <= MAX_SAFE_AMOUNT,
            "amount too large: would overflow fee calculation"
        );
        assert!(memo.len() <= MAX_MEMO_BYTES, "memo exceeds maximum length");

        let fee_bps: u32 = env.storage().instance().get(&DataKey::FeeBps).unwrap_or(0);
        let discount = rebate_bps(env, source, token_address);
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
            let new_accumulated = accumulated
                .checked_add(fee)
                .expect("accumulated fee overflow");
            env.storage()
                .instance()
                .set(&DataKey::AccumulatedFees, &new_accumulated);

            if Self::is_fee_token_whitelisted(env.clone(), token_address.clone()) {
                let token_fee_rate = Self::fee_token_rate(env.clone(), token_address.clone());
                let token_fee = (fee * token_fee_rate as i128) / 10000;
                let token_accumulated: i128 = env
                    .storage()
                    .instance()
                    .get(&DataKey::AccumulatedFeesByToken(token_address.clone()))
                    .unwrap_or(0);
                let new_token_accumulated = token_accumulated
                    .checked_add(token_fee)
                    .expect("token fee accumulator overflow");
                env.storage().instance().set(
                    &DataKey::AccumulatedFeesByToken(token_address.clone()),
                    &new_token_accumulated,
                );
            }
        }
        tk.transfer(&env.current_contract_address(), target, &net_amount);

        let vol_key = DataKey::UserVolume(source.clone(), token_address.clone());
        let vol: i128 = env.storage().persistent().get(&vol_key).unwrap_or(0);
        env.storage().persistent().set(&vol_key, &(vol + amount));
        Self::extend_persistent_ttl(env, &vol_key);

        let count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::FundingCount)
            .unwrap_or(0);
        let id = count.checked_add(1).expect("funding count overflow");
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
        let hot_count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::HotCount)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::HotCount, &(hot_count + 1));

        // #20: increment analytics counters atomically
        let total_vol: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalVolume)
            .unwrap_or(0);
        let new_total_vol = total_vol
            .checked_add(amount)
            .expect("total volume overflow");
        env.storage()
            .instance()
            .set(&DataKey::TotalVolume, &new_total_vol);

        // Track per-token volume separately for meaningful multi-token analytics
        let token_vol_key = DataKey::TotalVolumeByToken(token_address.clone());
        let token_vol: i128 = env
            .storage()
            .persistent()
            .get(&token_vol_key)
            .unwrap_or(0);
        env.storage()
            .persistent()
            .set(&token_vol_key, &(token_vol + amount));
        Self::extend_persistent_ttl(env, &token_vol_key);

        let unique_key = DataKey::UniqueFunder(source.clone());
        if !env.storage().persistent().has(&unique_key) {
            env.storage().persistent().set(&unique_key, &true);
            let uc: u64 = env
                .storage()
                .instance()
                .get(&DataKey::UniqueFunderCount)
                .unwrap_or(0);
            let new_uc = uc.checked_add(1).expect("unique funder count overflow");
            env.storage()
                .instance()
                .set(&DataKey::UniqueFunderCount, &new_uc);
        }

        Funded {
            source: source.clone(),
            target: target.clone(),
            token: token_address.clone(),
            amount,
            fee,
            discount,
        }
        .publish(env);

        Ok(fee)
    }

    pub fn batch_fund_c_address(
        env: Env,
        source: Address,
        targets: Vec<Address>,
        token_addresses: Vec<Address>,
        amounts: Vec<i128>,
        memos: Vec<String>,
    ) -> Result<(i128, u32), BridgeError> {
        Self::extend_ttl(&env);
        Self::pre_reentrancy_check(&env)?;
        source.require_auth();

        let count = targets.len();
        if count == 0 {
            return Err(BridgeError::EmptyBatch);
        }
        if token_addresses.len() != count || amounts.len() != count || memos.len() != count {
            return Err(BridgeError::MismatchedBatchLengths);
        }

        for i in 0..count {
            Self::validate_c_address(&targets.get(i).unwrap())?;
        }

        Self::set_reentrancy_guard(&env);

        let mut total_fees: i128 = 0;
        for i in 0..count {
            let target = targets.get(i).unwrap();
            let token_addr = token_addresses.get(i).unwrap();
            let amount = amounts.get(i).unwrap();
            let memo = memos.get(i).unwrap();
            total_fees += Self::fund_c_address_internal(
                &env, &source, &target, &token_addr, amount, &memo,
            )?;
        }

        BatchFunded {
            source,
            count,
            total_fees,
        }
        .publish(&env);

        Self::clear_reentrancy_guard(&env);
        Ok((total_fees, count))
    }

    /// Route a CEX withdrawal to a C-address.
    pub fn route_from_exchange(
        env: Env,
        exchange: Address,
        target: Address,
        token_address: Address,
        amount: i128,
        memo: String,
    ) -> Result<i128, BridgeError> {
        Self::extend_ttl(&env);
        Self::pre_reentrancy_check(&env)?;
        Self::validate_c_address(&target)?;
        if amount <= 0 {
            return Err(BridgeError::AmountNotPositive);
        }
        if env
            .storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
        {
            return Err(BridgeError::ContractPaused);
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

    fn archive_old_entries_internal(env: &Env, count: u32) -> Result<BytesN<32>, BridgeError> {
        Self::extend_ttl(env);

        let total: u32 = env
            .storage()
            .instance()
            .get(&DataKey::FundingCount)
            .unwrap_or(0);
        let archive_count = if count > total { total } else { count };
        if archive_count == 0 {
            return Err(BridgeError::NoEntriesToArchive);
        }

        let mut hash_bytes = Bytes::new(env);
        let end = start + archive_count - 1;
        for i in start..=end {
            if let Some(mut record) = env
                .storage()
                .persistent()
                .get::<DataKey, FundingRecord>(&DataKey::Funding(i))
            {
                if !record.archived {
                    let hot_count: u32 = env
                        .storage()
                        .instance()
                        .get(&DataKey::HotCount)
                        .unwrap_or(0);
                    env.storage()
                        .instance()
                        .set(&DataKey::HotCount, &hot_count.saturating_sub(1));
                }
                record.archived = true;
                hash_bytes.append(&record.source.to_string().to_bytes());
                hash_bytes.append(&record.target.to_string().to_bytes());
                hash_bytes.append(&record.token_address.to_string().to_bytes());
                hash_bytes.extend_from_array(&record.amount.to_be_bytes());
                hash_bytes.extend_from_array(&record.fee.to_be_bytes());
                hash_bytes.extend_from_array(&record.ledger.to_be_bytes());
                hash_bytes.append(&record.memo.to_bytes());
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
        env.storage()
            .instance()
            .set(&DataKey::NextArchiveRecordId, &(end + 1));

        Archived {
            archive_count,
            hash: hash_val.clone(),
        }
        .publish(env);

        Ok(hash_val)
    }

    /// Returns `(funding_count, archived_batch_count, accumulated_fees, hot_count)`
    /// where `hot_count` is the number of funding records still in "hot"
    /// (non-archived) persistent storage, derived by scanning each record's
    /// `archived` flag.
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

        let hot_count = env
            .storage()
            .instance()
            .get(&DataKey::HotCount)
            .unwrap_or(0);

        (funding_count, archived_count, accumulated_fees, hot_count)
    }

    pub fn propose(env: Env, proposer: Address, action: ProposalAction, expiry_blocks: u32) -> u32 {
        Self::extend_ttl(&env);
        proposer.require_auth();

        let admins: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Admins)
            .ok_or(BridgeError::NotInitialized)?;
        if !is_admin_in_list(&admins, &proposer) {
            return Err(BridgeError::OnlyAdminsCanPropose);
        }
        if expiry_blocks < 10 {
            return Err(BridgeError::ExpiryTooShort);
        }
        if expiry_blocks > 100_000 {
            return Err(BridgeError::ExpiryTooLong);
        }

        let nonce: u32 = env
            .storage()
            .instance()
            .get(&DataKey::ProposalNonce)
            .unwrap_or(0);
        let proposal_id = nonce + 1;
        let current_block = env.ledger().sequence();

        let approval_key = DataKey::ProposalApproval(proposal_id, proposer.clone());
        env.storage().persistent().set(&approval_key, &true);
        Self::extend_persistent_ttl(&env, &approval_key);

        let proposal = Proposal {
            id: proposal_id,
            action,
            proposer: proposer.clone(),
            approval_count: 1,
            executed: false,
            expiry: current_block + expiry_blocks,
            proposed_at: current_block,
        };

        let proposal_key = DataKey::Proposal(proposal_id);
        env.storage().persistent().set(&proposal_key, &proposal);
        Self::extend_persistent_ttl(&env, &proposal_key);
        env.storage()
            .instance()
            .set(&DataKey::ProposalNonce, &proposal_id);
        let mut active_ids: Vec<u32> = env
            .storage()
            .instance()
            .get(&DataKey::ActiveProposalIds)
            .unwrap_or(Vec::new(&env));
        active_ids.push_back(proposal_id);
        env.storage()
            .instance()
            .set(&DataKey::ActiveProposalIds, &active_ids);

        Proposed {
            proposal_id,
            proposer,
            expiry: current_block + expiry_blocks,
        }
        .publish(&env);

        Ok(proposal_id)
    }

    pub fn approve(env: Env, admin: Address, proposal_id: u32) {
        Self::extend_ttl(&env);
        admin.require_auth();

        let admins: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Admins)
            .ok_or(BridgeError::NotInitialized)?;
        if !is_admin_in_list(&admins, &admin) {
            return Err(BridgeError::OnlyAdminsCanApprove);
        }

        let mut proposal: Proposal = env
            .storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
            .ok_or(BridgeError::ProposalNotFound)?;

        if env.ledger().sequence() > proposal.expiry {
            return Err(BridgeError::ProposalExpired);
        }
        if proposal.executed {
            return Err(BridgeError::ProposalAlreadyExecuted);
        }

        let approval_key = DataKey::ProposalApproval(proposal_id, admin.clone());
        assert!(
            !env.storage().persistent().has(&approval_key),
            "already approved this proposal"
        );
        env.storage().persistent().set(&approval_key, &true);
        Self::extend_persistent_ttl(&env, &approval_key);

        proposal.approval_count += 1;
        let proposal_key = DataKey::Proposal(proposal_id);
        env.storage().persistent().set(&proposal_key, &proposal);
        Self::extend_persistent_ttl(&env, &proposal_key);

        Approved {
            proposal_id,
            admin,
            approval_count: proposal.approval_count,
        }
        .publish(&env);
    }

    pub fn execute(env: Env, proposal_id: u32) -> i128 {
        Self::extend_ttl(&env);
        let threshold: u32 = env
            .storage()
            .instance()
            .get(&DataKey::Threshold)
            .ok_or(BridgeError::NotInitialized)?;

        let proposal: Proposal = env
            .storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
            .ok_or(BridgeError::ProposalNotFound)?;

        if env.ledger().sequence() > proposal.expiry {
            return Err(BridgeError::ProposalExpired);
        }
        if proposal.executed {
            return Err(BridgeError::ProposalAlreadyExecuted);
        }
        if proposal.approval_count < threshold {
            return Err(BridgeError::InsufficientApprovals);
        }

        // Enforce a minimum transparency window for every action that can
        // move funds, change fees, pause the bridge, or alter governance.
        let sensitive = matches!(
            proposal.action,
            ProposalAction::WithdrawFees(_, _, _)
                | ProposalAction::SetFee(_)
                | ProposalAction::Pause
                | ProposalAction::Unpause
                | ProposalAction::RotateAdmins(_)
                | ProposalAction::SetThreshold(_)
        );
        if sensitive {
            if env.ledger().sequence() < proposal.proposed_at + MIN_EXEC_DELAY {
                return Err(BridgeError::ExecutionTooSoon);
            }
        }

        let mut executed_proposal = proposal.clone();
        executed_proposal.executed = true;
        let proposal_key = DataKey::Proposal(proposal_id);
        env.storage().persistent().set(&proposal_key, &executed_proposal);
        Self::extend_persistent_ttl(&env, &proposal_key);
        let mut active_ids: Vec<u32> = env
            .storage()
            .instance()
            .get(&DataKey::ActiveProposalIds)
            .unwrap_or(Vec::new(&env));
        let mut remaining_ids = Vec::new(&env);
        for i in 0..active_ids.len() {
            let id = active_ids.get_unchecked(i);
            if id != proposal_id {
                remaining_ids.push_back(id);
            }
        }
        active_ids = remaining_ids;
        env.storage()
            .instance()
            .set(&DataKey::ActiveProposalIds, &active_ids);

        let result = match proposal.action {
            ProposalAction::SetFee(new_fee_bps) => {
                let max_fee: u32 = env
                    .storage()
                    .instance()
                    .get(&DataKey::MaxFeeBps)
                    .ok_or(BridgeError::NotInitialized)?;
                if new_fee_bps > max_fee {
                    return Err(BridgeError::FeeExceedsMaxFee);
                }
                env.storage().instance().set(&DataKey::FeeBps, &new_fee_bps);

                let mut params: InitializationParams = env
                    .storage()
                    .instance()
                    .get(&DataKey::InitializationParams)
                    .ok_or(BridgeError::NotInitialized)?;
                params.fee_bps = new_fee_bps;
                env.storage()
                    .instance()
                    .set(&DataKey::InitializationParams, &params);

                SetFee {
                    fee_bps: new_fee_bps,
                }
                .publish(&env);
                0i128
            }
            ProposalAction::SetFeeTokenWhitelist(token, enabled) => {
                let key = DataKey::FeeTokenWhitelist(token.clone());
                env.storage().persistent().set(&key, &enabled);
                Self::extend_persistent_ttl(&env, &key);
                env.events().publish(
                    (Symbol::new(&env, "set_fee_token_whitelist"),),
                    (token, enabled),
                );
                0i128
            }
            ProposalAction::SetFeeTokenRate(token, rate) => {
                assert!(rate >= 1000, "rate must be >= 1000");
                assert!(rate <= 20000, "rate must be <= 20000");
                let key = DataKey::FeeTokenRate(token.clone());
                env.storage().persistent().set(&key, &rate);
                Self::extend_persistent_ttl(&env, &key);
                env.events()
                    .publish((Symbol::new(&env, "set_fee_token_rate"),), (token, rate));
                0i128
            }
            ProposalAction::WithdrawFees(to, token, amount) => {
                let token_key = DataKey::AccumulatedFeesByToken(token.clone());
                let token_accumulated: i128 = env
                    .storage()
                    .instance()
                    .get(&token_key)
                    .unwrap_or(0);
                let withdraw_amount = if amount == 0 { token_accumulated } else { amount };
                assert!(
                    withdraw_amount <= token_accumulated,
                    "insufficient accumulated fees"
                );
                let remaining = token_accumulated - withdraw_amount;
                env.storage()
                    .instance()
                    .set(&token_key, &remaining);
                let accumulated: i128 = env
                    .storage()
                    .instance()
                    .get(&DataKey::AccumulatedFees)
                    .unwrap_or(0);
                let withdraw_amount = if amount == 0 { accumulated } else { amount };
                if withdraw_amount > accumulated {
                    return Err(BridgeError::InsufficientAccumulatedFees);
                }
                let remaining = accumulated - withdraw_amount;
                env.storage()
                    .instance()
                    .set(&DataKey::AccumulatedFees, &(accumulated - withdraw_amount));
                let tk = token::Client::new(&env, &token);
                tk.transfer(&env.current_contract_address(), &to, &withdraw_amount);
                Withdrawn {
                    to,
                    token,
                    amount: withdraw_amount,
                }
                .publish(&env);
                withdraw_amount
            }
            ProposalAction::Pause => {
                env.storage().instance().set(&DataKey::Paused, &true);
                Paused.publish(&env);
                0i128
            }
            ProposalAction::Unpause => {
                env.storage().instance().set(&DataKey::Paused, &false);
                Unpaused.publish(&env);
                0i128
            }
            ProposalAction::RotateAdmins(new_admins) => {
                if new_admins.is_empty() {
                    return Err(BridgeError::AdminsEmpty);
                }
                Self::validate_admins(&env, &new_admins)?;
                let threshold: u32 = env
                    .storage()
                    .instance()
                    .get(&DataKey::Threshold)
                    .ok_or(BridgeError::NotInitialized)?;
                if threshold > new_admins.len() {
                    return Err(BridgeError::ThresholdExceedsAdminCount);
                }
                env.storage().instance().set(&DataKey::Admins, &new_admins);
                AdminsRotated {
                    admins: new_admins.clone(),
                }
                .publish(&env);
                0i128
            }
            ProposalAction::SetThreshold(new_threshold) => {
                let admins: Vec<Address> = env
                    .storage()
                    .instance()
                    .get(&DataKey::Admins)
                    .ok_or(BridgeError::NotInitialized)?;
                if new_threshold == 0 {
                    return Err(BridgeError::ThresholdZero);
                }
                if new_threshold > admins.len() {
                    return Err(BridgeError::ThresholdExceedsAdminCount);
                }
                env.storage()
                    .instance()
                    .set(&DataKey::Threshold, &new_threshold);
                ThresholdSet {
                    threshold: new_threshold,
                }
                .publish(&env);
                0i128
            }
            ProposalAction::ArchiveOldEntries(count) => {
                Self::archive_old_entries_internal(&env, count)?;
                0i128
            }
            ProposalAction::SetRebateTier(tier_index, threshold, discount_bps) => {
                assert!(discount_bps <= 5000, "discount capped at 50%");
                assert!(tier_index < MAX_TIERS, "{}", ERR_TIER_CAP_EXCEEDED);
                let threshold_key = DataKey::TierThreshold(tier_index);
                let discount_key = DataKey::TierDiscount(tier_index);
                env.storage().persistent().set(&threshold_key, &threshold);
                env.storage()
                    .persistent()
                    .set(&discount_key, &discount_bps);
                Self::extend_persistent_ttl(&env, &threshold_key);
                Self::extend_persistent_ttl(&env, &discount_key);
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
                TierSet {
                    tier_index,
                    threshold,
                    discount_bps,
                }
                .publish(&env);
                0i128
            }
        };

        Executed { proposal_id }.publish(&env);

        Ok(result)
    }

    pub fn get_proposal(env: Env, proposal_id: u32) -> Result<Proposal, BridgeError> {
        env.storage()
            .instance()
            .get(&DataKey::Proposal(proposal_id))
            .ok_or(BridgeError::ProposalNotFound)
    }

    pub fn get_active_proposals(env: Env) -> Vec<Proposal> {
        let current_block = env.ledger().sequence();
        let mut active: Vec<Proposal> = Vec::new(&env);
        let mut active_ids = Vec::new(&env);
        let proposal_ids: Vec<u32> = env
            .storage()
            .instance()
            .get(&DataKey::ActiveProposalIds)
            .unwrap_or(Vec::new(&env));

        for i in 0..proposal_ids.len() {
            let proposal_id = proposal_ids.get_unchecked(i);
            if let Some(proposal) = env
                .storage()
                .persistent()
                .get::<DataKey, Proposal>(&DataKey::Proposal(proposal_id))
            {
                if !proposal.executed && current_block <= proposal.expiry {
                    active.push_back(proposal);
                    active_ids.push_back(proposal_id);
                }
            }
        }
        env.storage()
            .instance()
            .set(&DataKey::ActiveProposalIds, &active_ids);

        active
    }

    /// Removes executed or expired proposals — and their per-admin approval
    /// flags — from instance storage.
    ///
    /// `propose`/`approve` write `DataKey::Proposal`/`DataKey::ProposalApproval`
    /// into instance storage and previously nothing ever removed them, so the
    /// contract's instance footprint grew forever with governance activity.
    /// This sweeps forward from the last pruned id, scanning at most
    /// `max_scan` proposals, stopping early if it reaches a proposal that is
    /// still active (neither executed nor expired) so a later call can pick
    /// up from there once it becomes terminal. Returns the number of
    /// proposals actually pruned.
    pub fn prune_proposals(env: Env, max_scan: u32) -> Result<u32, BridgeError> {
        let admins: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Admins)
            .ok_or(BridgeError::NotInitialized)?;
        if !admins.is_empty() {
            admins.get_unchecked(0).require_auth();
        }
        Self::extend_ttl(&env);

        let nonce: u32 = env
            .storage()
            .instance()
            .get(&DataKey::ProposalNonce)
            .unwrap_or(0);
        let mut cursor: u32 = env
            .storage()
            .instance()
            .get(&DataKey::NextPruneId)
            .unwrap_or(1);
        let current_block = env.ledger().sequence();

        let mut pruned: u32 = 0;
        let mut scanned: u32 = 0;

        while cursor <= nonce && scanned < max_scan {
            match env
                .storage()
                .persistent()
                .get::<DataKey, Proposal>(&DataKey::Proposal(cursor))
            {
                Some(proposal) => {
                    if proposal.executed || current_block > proposal.expiry {
                        env.storage().persistent().remove(&DataKey::Proposal(cursor));
                        for i in 0..admins.len() {
                            let approval_key =
                                DataKey::ProposalApproval(cursor, admins.get_unchecked(i));
                            env.storage().persistent().remove(&approval_key);
                        }
                        // The proposer always has an approval flag from
                        // `propose`, even if no longer an admin by the time
                        // this runs — clear it explicitly so it can't linger.
                        env.storage()
                            .persistent()
                            .remove(&DataKey::ProposalApproval(cursor, proposal.proposer));
                        pruned += 1;
                        cursor += 1;
                    } else {
                        // Still active: stop advancing so a future call
                        // resumes here instead of skipping it permanently.
                        break;
                    }
                }
                None => {
                    // Already pruned in a previous call — keep advancing.
                    cursor += 1;
                }
            }
            scanned += 1;
        }

        env.storage().instance().set(&DataKey::NextPruneId, &cursor);

        ProposalsPruned { pruned, cursor }.publish(&env);

        Ok(pruned)
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
