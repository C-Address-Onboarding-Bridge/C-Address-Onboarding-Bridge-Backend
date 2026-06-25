#![no_std]
#![allow(deprecated)]

use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, String, Symbol};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    FeeBps,
    AccumulatedFees,
    Version,
}

#[contract]
pub struct OnboardingBridge;

#[contractimpl]
impl OnboardingBridge {
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

    pub fn version(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::Version).unwrap_or(0)
    }

    pub fn admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized")
    }

    pub fn fee_bps(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::FeeBps).unwrap_or(0)
    }

    pub fn accumulated_fees(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::AccumulatedFees)
            .unwrap_or(0)
    }

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

    pub fn fund_c_address(
        env: Env,
        source: Address,
        target: Address,
        _token_address: Address,
        amount: i128,
        _memo: String,
    ) -> i128 {
        assert!(amount > 0, "amount must be positive");
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
        Self::fund_c_address(env, exchange, target, token_address, amount, memo)
    }
}

mod test;
