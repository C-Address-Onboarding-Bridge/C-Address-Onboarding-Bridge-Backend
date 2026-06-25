#![no_std]
#![allow(deprecated)]

use soroban_sdk::{
    contract, contractimpl, contracttype, token, Address, Bytes, BytesN, Env, String, Symbol,
};

// ---------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    FeeBps,
    AccumulatedFees(Address), // per-token, keyed by token address
    Version,
    // Timelock
    TimelockDelay,
    Paused,
    PendingOp(BytesN<32>),
    // Amount constraints
    MinAmount,
    MaxAmount,
}

// ---------------------------------------------------------------------------
// Pending operation (timelock)
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone)]
pub struct PendingOperation {
    pub op_hash: BytesN<32>,
    pub ready_at: u64,
    pub cancelled: bool,
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct OnboardingBridge;

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

fn get_admin(env: &Env) -> Address {
    env.storage()
        .instance()
        .get(&DataKey::Admin)
        .expect("not initialized")
}

fn require_admin(env: &Env) -> Address {
    let admin = get_admin(env);
    admin.require_auth();
    admin
}

fn assert_not_paused(env: &Env) {
    assert!(
        !env.storage()
            .instance()
            .get::<DataKey, bool>(&DataKey::Paused)
            .unwrap_or(false),
        "contract is paused"
    );
}

fn make_op_hash(env: &Env, label: &str) -> BytesN<32> {
    let mut b = Bytes::new(env);
    for byte in label.as_bytes() {
        b.push_back(*byte);
    }
    env.crypto().sha256(&b)
}

fn propose(env: &Env, label: &str) -> (BytesN<32>, u64) {
    let delay: u64 = env
        .storage()
        .instance()
        .get(&DataKey::TimelockDelay)
        .unwrap_or(0);
    let ready_at = env.ledger().timestamp() + delay;
    let hash = make_op_hash(env, label);
    let op = PendingOperation {
        op_hash: hash.clone(),
        ready_at,
        cancelled: false,
    };
    env.storage()
        .instance()
        .set(&DataKey::PendingOp(hash.clone()), &op);
    (hash, ready_at)
}

fn assert_op_ready(env: &Env, label: &str) {
    let hash = make_op_hash(env, label);
    let op: PendingOperation = env
        .storage()
        .instance()
        .get(&DataKey::PendingOp(hash))
        .expect("op not found");
    assert!(!op.cancelled, "op cancelled");
    assert!(
        env.ledger().timestamp() >= op.ready_at,
        "timelock not elapsed"
    );
}

// ---------------------------------------------------------------------------
// Contract implementation
// ---------------------------------------------------------------------------

#[contractimpl]
impl OnboardingBridge {
    pub fn initialize(env: Env, admin: Address, fee_bps: u32, timelock_delay: u64, min_amount: i128, max_amount: i128) {
        assert!(
            !env.storage().instance().has(&DataKey::Admin),
            "already initialized"
        );
        admin.require_auth();
        assert!(fee_bps <= 10000, "fee_bps must be <= 10000");
        assert!(min_amount >= 1, "min_amount >= 1");
        assert!(max_amount >= min_amount, "max_amount >= min_amount");
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::FeeBps, &fee_bps);
        env.storage()
            .instance()
            .set(&DataKey::TimelockDelay, &timelock_delay);
        env.storage().instance().set(&DataKey::MinAmount, &min_amount);
        env.storage().instance().set(&DataKey::MaxAmount, &max_amount);
        env.storage().instance().set(&DataKey::Paused, &false);
        env.storage().instance().set(&DataKey::Version, &2u32);
        env.events()
            .publish((Symbol::new(&env, "initialize"),), (admin, fee_bps));
    }

    // -----------------------------------------------------------------------
    // Getters
    // -----------------------------------------------------------------------

    pub fn version(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::Version).unwrap_or(0)
    }

    pub fn admin(env: Env) -> Address {
        get_admin(&env)
    }

    pub fn fee_bps(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::FeeBps).unwrap_or(0)
    }

    /// Returns accumulated fees for a specific token.
    pub fn accumulated_fees(env: Env, token: Address) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::AccumulatedFees(token))
            .unwrap_or(0)
    }

    pub fn timelock_delay(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::TimelockDelay)
            .unwrap_or(0)
    }

    pub fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    pub fn min_amount(env: Env) -> i128 {
        env.storage().instance().get(&DataKey::MinAmount).unwrap_or(1)
    }

    pub fn max_amount(env: Env) -> i128 {
        env.storage().instance().get(&DataKey::MaxAmount).unwrap_or(i128::MAX)
    }

    pub fn pending_op(env: Env, hash: BytesN<32>) -> Option<PendingOperation> {
        env.storage().instance().get(&DataKey::PendingOp(hash))
    }

    // -----------------------------------------------------------------------
    // Timelock: propose / cancel
    // -----------------------------------------------------------------------

    pub fn propose_op(env: Env, label: String) -> (BytesN<32>, u64) {
        require_admin(&env);
        let (hash, ready_at) = propose(&env, label.to_string().as_str());
        env.events().publish(
            (Symbol::new(&env, "op_proposed"),),
            (hash.clone(), ready_at),
        );
        (hash, ready_at)
    }

    pub fn cancel_op(env: Env, hash: BytesN<32>) {
        require_admin(&env);
        let mut op: PendingOperation = env
            .storage()
            .instance()
            .get(&DataKey::PendingOp(hash.clone()))
            .expect("op not found");
        assert!(!op.cancelled, "already cancelled");
        op.cancelled = true;
        env.storage()
            .instance()
            .set(&DataKey::PendingOp(hash.clone()), &op);
        env.events()
            .publish((Symbol::new(&env, "op_cancelled"),), (hash,));
    }

    // -----------------------------------------------------------------------
    // Timelocked fee update
    // -----------------------------------------------------------------------

    pub fn propose_set_fee(env: Env, op_label: String) -> (BytesN<32>, u64) {
        require_admin(&env);
        let (hash, ready_at) = propose(&env, op_label.to_string().as_str());
        env.events().publish(
            (Symbol::new(&env, "fee_proposed"),),
            (hash.clone(), ready_at),
        );
        (hash, ready_at)
    }

    pub fn execute_set_fee(env: Env, new_fee_bps: u32, op_label: String) {
        require_admin(&env);
        assert!(new_fee_bps <= 10000, "fee_bps must be <= 10000");
        assert_op_ready(&env, op_label.to_string().as_str());
        env.storage().instance().set(&DataKey::FeeBps, &new_fee_bps);
        env.events()
            .publish((Symbol::new(&env, "set_fee"),), (new_fee_bps,));
    }

    pub fn set_fee(env: Env, new_fee_bps: u32) {
        require_admin(&env);
        assert!(new_fee_bps <= 10000, "fee_bps must be <= 10000");
        env.storage().instance().set(&DataKey::FeeBps, &new_fee_bps);
        env.events()
            .publish((Symbol::new(&env, "set_fee"),), (new_fee_bps,));
    }

    // -----------------------------------------------------------------------
    // Emergency pause
    // -----------------------------------------------------------------------

    pub fn pause(env: Env) {
        require_admin(&env);
        env.storage().instance().set(&DataKey::Paused, &true);
        env.events()
            .publish((Symbol::new(&env, "paused"),), (true,));
    }

    pub fn unpause(env: Env) {
        require_admin(&env);
        env.storage().instance().set(&DataKey::Paused, &false);
        env.events()
            .publish((Symbol::new(&env, "paused"),), (false,));
    }

    // -----------------------------------------------------------------------
    // Amount constraints (timelocked)
    // -----------------------------------------------------------------------

    pub fn propose_set_min(env: Env, op_label: String) -> (BytesN<32>, u64) {
        require_admin(&env);
        let (hash, ready_at) = propose(&env, op_label.to_string().as_str());
        (hash, ready_at)
    }

    pub fn execute_set_min(env: Env, min: i128, op_label: String) {
        require_admin(&env);
        assert!(min >= 1, "min_amount >= 1");
        assert_op_ready(&env, op_label.to_string().as_str());
        let max: i128 = env.storage().instance().get(&DataKey::MaxAmount).unwrap_or(i128::MAX);
        assert!(min <= max, "min_amount <= max_amount");
        env.storage().instance().set(&DataKey::MinAmount, &min);
        env.events().publish((Symbol::new(&env, "min_amount_set"),), (min,));
    }

    pub fn propose_set_max(env: Env, op_label: String) -> (BytesN<32>, u64) {
        require_admin(&env);
        let (hash, ready_at) = propose(&env, op_label.to_string().as_str());
        (hash, ready_at)
    }

    pub fn execute_set_max(env: Env, max: i128, op_label: String) {
        require_admin(&env);
        assert!(max >= 1, "max_amount >= 1");
        assert_op_ready(&env, op_label.to_string().as_str());
        let min: i128 = env.storage().instance().get(&DataKey::MinAmount).unwrap_or(1);
        assert!(max >= min, "max_amount >= min_amount");
        env.storage().instance().set(&DataKey::MaxAmount, &max);
        env.events().publish((Symbol::new(&env, "max_amount_set"),), (max,));
    }

    // -----------------------------------------------------------------------
    // Core: fund via SAC token transfer
    // -----------------------------------------------------------------------

    pub fn fund_c_address(
        env: Env,
        source: Address,
        target: Address,
        token_address: Address,
        amount: i128,
        memo: String,
    ) -> i128 {
        assert_not_paused(&env);
        source.require_auth();

        let min: i128 = env.storage().instance().get(&DataKey::MinAmount).unwrap_or(1);
        let max: i128 = env.storage().instance().get(&DataKey::MaxAmount).unwrap_or(i128::MAX);
        assert!(amount >= min, "amount below minimum");
        assert!(amount <= max, "amount above maximum");

        let fee_bps: u32 = env.storage().instance().get(&DataKey::FeeBps).unwrap_or(0);
        let fee_amount = if fee_bps > 0 {
            (amount * fee_bps as i128) / 10000
        } else {
            0i128
        };
        let net_amount = amount - fee_amount;

        // SAC cross-contract token transfers
        let tk = token::Client::new(&env, &token_address);
        tk.transfer(&source, &env.current_contract_address(), &amount);
        tk.transfer(&env.current_contract_address(), &target, &net_amount);

        // Accumulate per-token fees
        if fee_amount > 0 {
            let key = DataKey::AccumulatedFees(token_address.clone());
            let acc: i128 = env.storage().instance().get(&key).unwrap_or(0);
            env.storage().instance().set(&key, &(acc + fee_amount));
        }

        env.events().publish(
            (Symbol::new(&env, "funded"),),
            (source, target, amount, fee_amount, memo),
        );
        fee_amount
    }

    // -----------------------------------------------------------------------
    // Withdraw accumulated fees for a specific token
    // -----------------------------------------------------------------------

    pub fn withdraw_fees(env: Env, to: Address, token_address: Address, amount: i128) -> i128 {
        require_admin(&env);
        let key = DataKey::AccumulatedFees(token_address.clone());
        let accumulated: i128 = env.storage().instance().get(&key).unwrap_or(0);
        let withdraw_amount = if amount == 0 { accumulated } else { amount };
        assert!(
            withdraw_amount <= accumulated,
            "insufficient accumulated fees"
        );
        env.storage()
            .instance()
            .set(&key, &(accumulated - withdraw_amount));

        let tk = token::Client::new(&env, &token_address);
        tk.transfer(&env.current_contract_address(), &to, &withdraw_amount);

        env.events().publish(
            (Symbol::new(&env, "withdrawn"),),
            (to, token_address, withdraw_amount),
        );
        withdraw_amount
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
        Self::fund_c_address(env, exchange, target, token_address, amount, memo)
    }
}

mod test;
