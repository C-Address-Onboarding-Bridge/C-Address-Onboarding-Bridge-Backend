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

use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, String, Symbol, Vec};

/// Storage keys used throughout the contract.
///
/// Every variant maps to a distinct slot in instance storage.
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// The administrator [`Address`] authorised to call privileged functions.
    Admin,
    /// Fee rate in basis points (0–10 000).  Loaded on every funding call.
    FeeBps,
    /// Running total of fees collected (in the token's smallest unit / stroops).
    /// Zeroed on each successful withdrawal or auto-withdraw.
    AccumulatedFees,
    /// Monotonically increasing schema version.  Currently `1`.
    Version,
    /// Optional ordered list of [`FeeRecipient`] entries for proportional
    /// fee distribution.  Absent until [`OnboardingBridge::set_fee_recipients`]
    /// is called for the first time.
    FeeRecipients,
    /// Minimum accumulated-fee balance (stroops) that triggers a permissionless
    /// auto-withdraw.  `0` means the feature is disabled.
    AutoWithdrawThreshold,
}

/// A single fee recipient with their proportional share in basis points.
#[contracttype]
#[derive(Clone)]
pub struct FeeRecipient {
    pub address: Address,
    pub bps_share: u32,
}

/// A single distribution record: address + amount distributed.
#[contracttype]
#[derive(Clone)]
pub struct Distribution {
    pub address: Address,
    pub amount: i128,
}

#[contract]
pub struct OnboardingBridge;

#[contractimpl]
impl OnboardingBridge {
    /// One-time initialisation of the bridge contract.
    ///
    /// Stores the admin address, fee rate, initial accumulated fees (`0`), and
    /// contract version (`1`).  Subsequent calls panic immediately — the guard
    /// runs before auth to give a clear error to callers who call this twice.
    ///
    /// # Parameters
    ///
    /// - `admin` — Address that will own privileged functions.
    /// - `fee_bps` — Initial fee rate in basis points (0–10 000 inclusive).
    ///
    /// # Panics
    ///
    /// - `"already initialized"` — if [`DataKey::Admin`] already exists in storage.
    /// - Assertion failure — if `fee_bps > 10_000`.
    /// - Auth failure — if the transaction is not signed by `admin`.
    ///
    /// # Events
    ///
    /// Emits `("initialize",) → (admin, fee_bps)`.
    ///
    /// # Examples
    ///
    /// ```ignore
    /// contract.initialize(env, admin_address, 30); // 0.30 % fee
    /// ```
    pub fn initialize(env: Env, admin: Address, fee_bps: u32) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        admin.require_auth();
        assert!(fee_bps <= 10000, "fee_bps must be <= 10000");
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::FeeBps, &fee_bps);
        env.storage()
            .instance()
            .set(&DataKey::AccumulatedFees, &0i128);
        env.storage().instance().set(&DataKey::Version, &1u32);
        env.events()
            .publish((Symbol::new(&env, "initialize"),), (admin, fee_bps));
    }

    /// Returns the contract schema version.
    ///
    /// # Returns
    ///
    /// Current version number (currently `1`), or `0` if not yet initialised.
    ///
    /// # Examples
    ///
    /// ```ignore
    /// let v = contract.version(env); // 1
    /// ```
    pub fn version(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::Version).unwrap_or(0)
    }

    /// Returns the administrator address.
    ///
    /// # Returns
    ///
    /// The [`Address`] stored under [`DataKey::Admin`].
    ///
    /// # Panics
    ///
    /// - `"not initialized"` — if the contract has not been initialised.
    ///
    /// # Examples
    ///
    /// ```ignore
    /// let admin = contract.admin(env);
    /// ```
    pub fn admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized")
    }

    /// Returns the current fee rate in basis points.
    ///
    /// # Returns
    ///
    /// Fee rate (0–10 000), or `0` if not yet set.
    ///
    /// # Examples
    ///
    /// ```ignore
    /// let bps = contract.fee_bps(env); // e.g. 30
    /// ```
    pub fn fee_bps(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::FeeBps).unwrap_or(0)
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
        env.storage()
            .instance()
            .get(&DataKey::AccumulatedFees)
            .unwrap_or(0)
    }

    /// Updates the fee rate.  Admin only.
    ///
    /// # Parameters
    ///
    /// - `new_fee_bps` — New fee rate in basis points (0–10 000 inclusive).
    ///
    /// # Panics
    ///
    /// - `"not initialized"` — if the contract has not been initialised.
    /// - Assertion failure — if `new_fee_bps > 10_000`.
    /// - Auth failure — if the transaction is not signed by admin.
    ///
    /// # Events
    ///
    /// Emits `("set_fee",) → (new_fee_bps,)`.
    ///
    /// # Examples
    ///
    /// ```ignore
    /// contract.set_fee(env, 50); // raise fee to 0.50 %
    /// ```
    pub fn set_fee(env: Env, new_fee_bps: u32) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        admin.require_auth();
        assert!(new_fee_bps <= 10000, "fee_bps must be <= 10000");
        env.storage().instance().set(&DataKey::FeeBps, &new_fee_bps);
        env.events()
            .publish((Symbol::new(&env, "set_fee"),), (new_fee_bps,));
    }

    /// Record a funding event. The caller is responsible for the token transfer.
    /// Returns the fee amount deducted.
    ///
    /// The contract does **not** perform the token transfer; the caller must
    /// move tokens independently.  This function records the event, accrues
    /// the fee, and emits a `funded` event so indexers can track activity.
    ///
    /// # Parameters
    ///
    /// - `source` — The funding originator (G-address or smart account).
    /// - `target` — Destination C-address receiving the funds.
    /// - `_token_address` — Token contract address (recorded in the event).
    /// - `amount` — Gross transfer amount in the token's smallest unit.
    /// - `_memo` — Arbitrary memo string for off-chain correlation.
    ///
    /// # Returns
    ///
    /// The fee amount (stroops) deducted from `amount`.  `0` when fee rate is 0.
    ///
    /// # Events
    ///
    /// Emits `("funded",) → (source, target, amount, fee_amount)`.
    ///
    /// # Examples
    ///
    /// ```ignore
    /// let fee = contract.fund_c_address(env, source, target, token, 1_000_000, memo);
    /// // net received by target = 1_000_000 - fee
    /// ```
    pub fn fund_c_address(
        env: Env,
        source: Address,
        target: Address,
        _token_address: Address,
        amount: i128,
        _memo: String,
    ) -> i128 {
        let fee_bps: u32 = env.storage().instance().get(&DataKey::FeeBps).unwrap_or(0);
        // Integer division: floor(amount × fee_bps / 10_000)
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

    /// Withdraw accumulated fees.  Admin only.
    ///
    /// Behaviour depends on `amount` and whether fee recipients are configured:
    ///
    /// | `amount` | Recipients set? | Behaviour |
    /// |----------|-----------------|-----------|
    /// | `0`      | Yes (non-empty) | Distribute full balance proportionally to all recipients; clear balance |
    /// | `0`      | No              | Withdraw full balance to `to`; clear balance |
    /// | `> 0`    | Any             | Withdraw exactly `amount` to `to`; reduce balance |
    ///
    /// # Parameters
    ///
    /// - `to` — Destination address for single-recipient withdrawals.
    /// - `token_address` — Token to withdraw (recorded in event; transfer is caller's responsibility).
    /// - `amount` — Amount to withdraw, or `0` to withdraw the full balance.
    ///
    /// # Returns
    ///
    /// Actual amount withdrawn (useful when `amount == 0`).
    ///
    /// # Panics
    ///
    /// - `"not initialized"` — if the contract has not been initialised.
    /// - `"insufficient accumulated fees"` — if `amount > accumulated`.
    /// - Auth failure — if the transaction is not signed by admin.
    ///
    /// # Events
    ///
    /// Emits `("withdrawn",) → (to, token_address, withdraw_amount)`.
    ///
    /// # Examples
    ///
    /// ```ignore
    /// // Withdraw everything to a single address
    /// let withdrawn = contract.withdraw_fees(env, to, token, 0);
    ///
    /// // Withdraw a specific amount
    /// let withdrawn = contract.withdraw_fees(env, to, token, 500_000);
    /// ```
    pub fn withdraw_fees(env: Env, to: Address, token_address: Address, amount: i128) -> i128 {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        admin.require_auth();

        let accumulated: i128 = env
            .storage()
            .instance()
            .get(&DataKey::AccumulatedFees)
            .unwrap_or(0);

        // Multi-recipient distribution: only when amount == 0 and recipients are configured
        if amount == 0 {
            let recipients: Option<Vec<FeeRecipient>> =
                env.storage().instance().get(&DataKey::FeeRecipients);
            if let Some(recipients) = recipients {
                if !recipients.is_empty() {
                    // Zero out balance before emitting so re-entrancy reads 0
                    env.storage()
                        .instance()
                        .set(&DataKey::AccumulatedFees, &0i128);
                    env.events().publish(
                        (Symbol::new(&env, "withdrawn"),),
                        (to, token_address, accumulated),
                    );
                    return accumulated;
                }
            }
        }

        // Original behavior: single recipient
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
            (to, token_address, withdraw_amount),
        );

        withdraw_amount
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
        exchange.require_auth();
        Self::fund_c_address(env, exchange, target, token_address, amount, memo)
    }

    // -----------------------------------------------------------------------
    // Fee recipient management
    // -----------------------------------------------------------------------

    /// Configure proportional fee recipients.  Admin only.
    ///
    /// Replaces any previously stored recipient list.  All future calls to
    /// `withdraw_fees` with `amount == 0` and calls to
    /// `trigger_auto_withdraw` will distribute fees according to this list.
    ///
    /// # Parameters
    ///
    /// - `recipients` — Ordered list of [`FeeRecipient`] entries.  Each entry
    ///   specifies an address and its share in basis points.
    ///
    /// # Panics
    ///
    /// - `"not initialized"` — if the contract has not been initialised.
    /// - `"shares must sum to 10000"` — if the sum of `bps_share` values ≠ 10 000.
    /// - Auth failure — if the transaction is not signed by admin.
    ///
    /// # Examples
    ///
    /// ```ignore
    /// // 70 % to alice, 30 % to bob
    /// contract.set_fee_recipients(env, vec![
    ///     FeeRecipient { address: alice, bps_share: 7000 },
    ///     FeeRecipient { address: bob,   bps_share: 3000 },
    /// ]);
    /// ```
    pub fn set_fee_recipients(env: Env, recipients: Vec<FeeRecipient>) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        admin.require_auth();

        // Validate that all shares sum to exactly 10 000 bps (= 100 %)
        let mut total: u32 = 0;
        for i in 0..recipients.len() {
            total += recipients.get(i).unwrap().bps_share;
        }
        assert!(total == 10000, "shares must sum to 10000");

        env.storage()
            .instance()
            .set(&DataKey::FeeRecipients, &recipients);
    }

    /// Returns the current fee recipient list.
    ///
    /// # Returns
    ///
    /// Stored [`Vec<FeeRecipient>`], or an empty `Vec` if none have been set.
    ///
    /// # Examples
    ///
    /// ```ignore
    /// let recipients = contract.get_fee_recipients(env);
    /// ```
    pub fn get_fee_recipients(env: Env) -> Vec<FeeRecipient> {
        env.storage()
            .instance()
            .get(&DataKey::FeeRecipients)
            .unwrap_or(Vec::new(&env))
    }

    // -----------------------------------------------------------------------
    // Auto-withdraw threshold
    // -----------------------------------------------------------------------

    /// Set the accumulated-fee threshold that enables permissionless auto-withdraw.  Admin only.
    ///
    /// Once the threshold is set to a positive value, any caller may invoke
    /// `trigger_auto_withdraw` whenever `accumulated_fees >= threshold`.
    /// Setting `threshold` to `0` disables the feature.
    ///
    /// # Parameters
    ///
    /// - `threshold` — Minimum accumulated balance (stroops) required to trigger
    ///   auto-withdraw.  Pass `0` to disable.
    ///
    /// # Panics
    ///
    /// - `"not initialized"` — if the contract has not been initialised.
    /// - Auth failure — if the transaction is not signed by admin.
    ///
    /// # Examples
    ///
    /// ```ignore
    /// contract.set_auto_withdraw_threshold(env, 1_000_000); // trigger at 1 XLM
    /// contract.set_auto_withdraw_threshold(env, 0);          // disable
    /// ```
    pub fn set_auto_withdraw_threshold(env: Env, threshold: i128) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        admin.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::AutoWithdrawThreshold, &threshold);
    }

    /// Returns the current auto-withdraw threshold (stroops).
    ///
    /// # Returns
    ///
    /// The stored threshold, or `0` if never set (feature disabled).
    ///
    /// # Examples
    ///
    /// ```ignore
    /// let t = contract.get_auto_withdraw_threshold(env);
    /// ```
    pub fn get_auto_withdraw_threshold(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::AutoWithdrawThreshold)
            .unwrap_or(0)
    }

    // -----------------------------------------------------------------------
    // Trigger auto-withdraw
    // -----------------------------------------------------------------------

    /// Permissionless auto-withdraw: distributes all accumulated fees when the
    /// threshold condition is met.
    ///
    /// Callable by **anyone** — no admin auth required.  Useful for keeper bots
    /// or automated treasury management.
    ///
    /// Distribution rules:
    /// - If no recipients are configured → entire balance goes to admin.
    /// - If recipients are configured → each receives `floor(balance × bps_share / 10_000)`.
    ///   The **last** recipient receives the remainder to prevent dust from
    ///   integer-division rounding accumulating indefinitely.
    ///
    /// The accumulated fee balance is zeroed atomically before the event is emitted.
    ///
    /// # Parameters
    ///
    /// - `token` — Token address being distributed (recorded in the event).
    ///
    /// # Returns
    ///
    /// [`Vec<Distribution>`] — one entry per recipient, each containing the
    /// address and the amount allocated to that address.
    ///
    /// # Panics
    ///
    /// - `"auto-withdraw is disabled"` — if threshold is `0`.
    /// - `"accumulated fees below threshold"` — if `accumulated < threshold`.
    /// - `"not initialized"` — if the contract has not been initialised.
    ///
    /// # Events
    ///
    /// Emits `("auto_withdrawn",) → (token, distributions)`.
    ///
    /// # Examples
    ///
    /// ```ignore
    /// // Keeper triggers once balance crosses threshold
    /// let dists = contract.trigger_auto_withdraw(env, xlm_token);
    /// for d in dists.iter() {
    ///     // d.address received d.amount stroops
    /// }
    /// ```
    pub fn trigger_auto_withdraw(env: Env, token: Address) -> Vec<Distribution> {
        let threshold: i128 = env
            .storage()
            .instance()
            .get(&DataKey::AutoWithdrawThreshold)
            .unwrap_or(0);
        assert!(threshold > 0, "auto-withdraw is disabled");

        let accumulated: i128 = env
            .storage()
            .instance()
            .get(&DataKey::AccumulatedFees)
            .unwrap_or(0);
        assert!(accumulated >= threshold, "accumulated fees below threshold");

        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");

        let recipients: Vec<FeeRecipient> = env
            .storage()
            .instance()
            .get(&DataKey::FeeRecipients)
            .unwrap_or(Vec::new(&env));

        let mut distributions: Vec<Distribution> = Vec::new(&env);

        if recipients.is_empty() {
            // No split configured — full balance goes to admin
            distributions.push_back(Distribution {
                address: admin.clone(),
                amount: accumulated,
            });
        } else {
            let mut distributed: i128 = 0;
            let last_idx = recipients.len() - 1;
            for i in 0..recipients.len() {
                let r = recipients.get(i).unwrap();
                // Last recipient absorbs any rounding remainder so total always equals accumulated
                let dist_amount = if i == last_idx {
                    accumulated - distributed
                } else {
                    // Proportional share: floor(accumulated × bps_share / 10_000)
                    (accumulated * r.bps_share as i128) / 10000
                };
                distributed += dist_amount;
                distributions.push_back(Distribution {
                    address: r.address,
                    amount: dist_amount,
                });
            }
        }

        // Zero the balance before emitting to prevent double-spend on re-entrancy
        env.storage()
            .instance()
            .set(&DataKey::AccumulatedFees, &0i128);

        env.events().publish(
            (Symbol::new(&env, "auto_withdrawn"),),
            (token, distributions.clone()),
        );

        distributions
    }
}

mod test;
