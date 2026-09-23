// The full end‑to‑end governance scenario test was previously ignored because the
// contract enforces a minimum execution delay (`MIN_EXEC_DELAY`).  The test
// executed actions immediately after the ledger was created, causing the
// contract to panic with *"execution too soon: minimum delay not elapsed"*.
// The fix is to advance the ledger sequence (or time) before each
// `execute()` call and to re‑enable the test.
//
// The test harness used in this repository is the Soroban testutils
// `Ledger`.  The `Ledger` type exposes an `advance()` method that
// increments the ledger sequence and a `advance_time()` method that
// moves the ledger clock forward.  For the purposes of the governance
// flow the sequence advancement is sufficient, so we use `ledger.advance()`.
//
// The changes below:
//   1. Remove the `#[ignore]` attribute so the test runs in CI.
//   2. Call `ledger.advance()` immediately before each call to
//      `contract.execute()` that performs a sensitive action.
//   3. Keep the rest of the test unchanged.
//
// This patch is minimal and preserves the original test logic while
// satisfying the contract's execution delay requirement.

use soroban_sdk::testutils::Ledger;
use soroban_sdk::{Env, Symbol};

use crate::contract::{Contract, ExecuteArgs, ExecuteResult};
use crate::state::{GovernanceAction, Proposal};

#[test]
fn test_full_scenario() {
    // Create a fresh ledger and environment.
    let mut ledger = Ledger::default();
    let env = Env::test(&ledger);

    // Deploy the contract.
    let contract = Contract::new(&env);

    // ------------------------------------------------------------------
    // 1️⃣  Create a proposal that will add a new address to the whitelist.
    // ------------------------------------------------------------------
    let proposal_id = 1;
    let action = GovernanceAction::AddAddress {
        address: Symbol::new(&env, "0x1234"),
    };
    let proposal = Proposal::new(proposal_id, action.clone());

    // Submit the proposal.
    // This is a sensitive action that requires the minimum execution delay.
    ledger.advance(); // Advance the ledger sequence before execution.
    contract.execute(
        &ExecuteArgs {
            proposal_id,
            action: ExecuteResult::Proposal(proposal.clone()),
        },
        &[],
    );

    // ------------------------------------------------------------------
    // 2️⃣  Execute the proposal after the delay has elapsed.
    // ------------------------------------------------------------------
    // The contract checks that the ledger sequence has advanced at least
    // `MIN_EXEC_DELAY` steps.  We advance the ledger again to satisfy this.
    ledger.advance(); // Advance the ledger sequence again.
    contract.execute(
        &ExecuteArgs {
            proposal_id,
            action: ExecuteResult::Execute(action),
        },
        &[],
    );

    // ------------------------------------------------------------------
    // 3️⃣  Verify that the address was added to the whitelist.
    // ------------------------------------------------------------------
    let whitelist = contract.get_whitelist();
    assert!(whitelist.contains(&Symbol::new(&env, "0x1234")));
}
