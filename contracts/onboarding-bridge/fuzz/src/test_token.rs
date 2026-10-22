/// Shared test token for fuzz targets.
/// Replicates the SEP-41 token interface used in the main contract tests.

use soroban_sdk::{
    contract, contractimpl, contracttype, Address, Env, String,
};

#[contracttype]
#[derive(Clone)]
enum TK {
    Bal(Address),
    Allowance(Address, Address),
}

#[contract]
pub struct TestToken;

#[contractimpl]
impl TestToken {
    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        from.require_auth();
        let fb: i128 = env
            .storage()
            .persistent()
            .get::<TK, i128>(&TK::Bal(from.clone()))
            .unwrap_or(0);
        assert!(fb >= amount, "insufficient balance");
        let tb: i128 = env
            .storage()
            .persistent()
            .get::<TK, i128>(&TK::Bal(to.clone()))
            .unwrap_or(0);
        env.storage()
            .persistent()
            .set(&TK::Bal(from), &(fb - amount));
        env.storage().persistent().set(&TK::Bal(to), &(tb + amount));
    }

    pub fn transfer_from(env: Env, spender: Address, from: Address, to: Address, amount: i128) {
        spender.require_auth();
        let allowance = env
            .storage()
            .persistent()
            .get::<TK, i128>(&TK::Allowance(from.clone(), spender.clone()))
            .unwrap_or(0);
        assert!(allowance >= amount, "insufficient allowance");
        let from_bal = env.storage().persistent().get::<TK, i128>(&TK::Bal(from.clone())).unwrap_or(0);
        assert!(from_bal >= amount, "insufficient balance");
        let to_bal = env.storage().persistent().get::<TK, i128>(&TK::Bal(to.clone())).unwrap_or(0);
        env.storage().persistent().set(&TK::Allowance(from.clone(), spender), &(allowance - amount));
        env.storage().persistent().set(&TK::Bal(from), &(from_bal - amount));
        env.storage().persistent().set(&TK::Bal(to), &(to_bal + amount));
    }

    pub fn approve(env: Env, from: Address, spender: Address, amount: i128, _expiration_ledger: u32) {
        from.require_auth();
        env.storage().persistent().set(&TK::Allowance(from, spender), &amount);
    }

    pub fn allowance(env: Env, from: Address, spender: Address) -> i128 {
        env.storage().persistent().get::<TK, i128>(&TK::Allowance(from, spender)).unwrap_or(0)
    }

    pub fn balance(env: Env, id: Address) -> i128 {
        env.storage().persistent().get::<TK, i128>(&TK::Bal(id)).unwrap_or(0)
    }

    pub fn mint(env: Env, to: Address, amount: i128) {
        let bal = env.storage().persistent().get::<TK, i128>(&TK::Bal(to.clone())).unwrap_or(0);
        env.storage().persistent().set(&TK::Bal(to), &(bal + amount));
    }

    pub fn decimals(_env: Env) -> u32 { 7 }

    pub fn name(env: Env) -> String { String::from_str(&env, "TestToken") }

    pub fn symbol(env: Env) -> String { String::from_str(&env, "TEST") }
}