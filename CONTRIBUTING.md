# Contributing to C-Address Onboarding Bridge

Thanks for your interest in contributing! This guide covers everything you need to open a high-quality PR: conventions, testing expectations, the review process, and how to get unstuck.

---

## Contents

1. [Quick Start](#quick-start)
2. [Good First Issues](#good-first-issues)
3. [Branch Naming](#branch-naming)
4. [Commit Messages](#commit-messages)
5. [Code Style](#code-style)
6. [Testing Expectations](#testing-expectations)
7. [Documentation Requirements](#documentation-requirements)
8. [Opening a Pull Request](#opening-a-pull-request)
9. [Code Review Process](#code-review-process)
10. [Review Checklist](#review-checklist)
11. [Escalation Path](#escalation-path)

---

## Quick Start

```bash
git clone https://github.com/C-Address-Onboarding-Bridge/C-Address-Onboarding-Bridge-Backend.git
cd C-Address-Onboarding-Bridge-Backend
npm install
cp .env.example .env
npm run build
npm run test --workspaces
```

For Rust / contract work you also need:

```bash
rustup target add wasm32v1-none
cargo install stellar-cli --locked
```

Full environment setup: see [docs/developer-setup.md](docs/developer-setup.md).

---

## Good First Issues

Issues tagged [`good first issue`](https://github.com/C-Address-Onboarding-Bridge/C-Address-Onboarding-Bridge-Backend/labels/good%20first%20issue) are scoped for new contributors. Comment on the issue before starting work so we can assign it to you and avoid duplicate effort.

### Soroban Contract
- Add `amount > 0` guard to `fund_c_address` — `contracts/onboarding-bridge/src/lib.rs`
- Add Stellar asset contract integration test

### API Server
- Add Soroban RPC health check to `/health`
- Add `GET /api/v1/quote` response caching (30-second TTL)

### TypeScript SDK
- Add pagination support to `BridgeClient`
- Add retry logic with exponential backoff to HTTP requests

### Documentation
- Add JSDoc comments to all public SDK methods
- Write a wallet integration guide

---

## Branch Naming

Use the following format:

```
<type>/<short-description>
```

| Type | When to use |
|------|-------------|
| `feat/` | New feature |
| `fix/` | Bug fix |
| `refactor/` | Code restructuring without behaviour change |
| `perf/` | Performance improvement |
| `test/` | Adding or fixing tests only |
| `docs/` | Documentation only |
| `chore/` | Build, CI, dependencies, tooling |
| `contract/` | Soroban smart contract changes |
| `security/` | Security fixes (use a private fork for vulnerabilities) |

**Examples:**

```
feat/pagination-sdk
fix/quote-cache-ttl
contract/multi-sig-threshold
docs/wallet-integration-guide
chore/update-stellar-cli
```

Keep descriptions lowercase and hyphenated. Avoid generic names like `fix/bug` or `feat/changes`.

---

## Commit Messages

This project follows [Conventional Commits](https://www.conventionalcommits.org/). Every commit on `main` must be parseable by a changelog generator.

### Format

```
<type>(<scope>): <short summary>

[optional body]

[optional footer(s)]
```

### Types

| Type | Use for |
|------|---------|
| `feat` | New user-facing feature |
| `fix` | Bug fix |
| `refactor` | Refactor without behaviour change |
| `perf` | Performance improvement |
| `test` | Test additions or corrections |
| `docs` | Documentation only |
| `chore` | Build, CI, tooling, dependency bumps |
| `style` | Formatting only (no logic change) |
| `revert` | Reverting a prior commit |

### Scopes

Use the component the change is in: `api`, `sdk`, `contract`, `cex`, `offramp`, `ci`, `docs`.

### Rules

- **Summary line**: ≤72 characters, imperative mood ("add pagination" not "added pagination"), no trailing period.
- **Body** (optional): wrap at 72 characters, explain *why* not *what*.
- **Breaking changes**: add `BREAKING CHANGE:` in the footer, or append `!` after the type: `feat(api)!: rename fund endpoint`.
- **Issue references**: `Closes #42`, `Fixes #17` in the footer.

### Examples

```
feat(sdk): add pagination support to BridgeClient

Adds a generic paginated request method and a paginate() helper that
automatically follows next-page cursors. Resolves the SDK TODO added
in #38.

Closes #38
```

```
fix(contract): reject zero-amount fund_c_address calls

The contract previously allowed zero-value transfers, which could be
used to emit funded events without transferring tokens.

Fixes #51
```

```
chore(ci): pin stellar-cli version to 22.0.1
```

```
feat(api)!: require X-API-Key on all v1 endpoints

BREAKING CHANGE: Unauthenticated access to /api/v1/* is no longer
allowed. Set API_KEYS in your .env to preserve local dev access.
```

---

## Code Style

### TypeScript

The project uses `strict: true` in `tsconfig.base.json`. Additionally:

- **No `any`**: use `unknown` and narrow, or define the type. `@ts-ignore` must have a comment explaining why.
- **No `console.log`**: use the `logger` instance from `api/src/logger.ts`. The ESLint `no-console` rule is currently a warning — treat it as an error for PRs.
- **Error handling**: every `async` function that can fail should handle the error explicitly (no unhandled promise rejections). `try/catch` or `.catch()` — not both mixed arbitrarily.
- **Imports**: absolute imports from `src/` root where possible; avoid deep `../../../` chains.
- **Naming**: `camelCase` for variables and functions, `PascalCase` for types/classes/interfaces, `UPPER_SNAKE_CASE` for module-level constants.
- **Zod schemas**: all API request bodies and query params must be validated with a Zod schema before use. Never trust `req.body` directly.
- **Return types**: explicit return types on all exported functions and class methods.

#### ESLint

Run before committing:

```bash
npm run lint --workspaces
# or in a specific package:
npx eslint --ext .ts src/   # from api/ or sdk/
```

The `.eslintrc.json` at the root is the baseline. Packages may extend it. Do not disable rules inline (`// eslint-disable`) without a comment explaining why.

#### Formatting

The project does not enforce Prettier yet. Match the surrounding code's style. Key conventions:
- 2-space indentation
- Single quotes for strings
- Semicolons at end of statements
- Trailing commas in multiline arrays/objects

### Rust (Smart Contract)

The contract targets `#![no_std]`. Follow these rules:

- **`require_auth()`**: every function that modifies state or moves funds must call `require_auth()` on the authorising address.
- **No `println!` / `dbg!`**: use `env.events().publish()` for observability.
- **Error messages**: use the module-level `const ERR_*: &str` pattern already established in `lib.rs`. No inline string literals in `panic!` or `assert!`.
- **`clippy`**: all clippy lints must pass. The CI runs `cargo clippy -- -D warnings`.
- **Formatting**: `cargo fmt` must produce no diff. The CI checks this.
- **Storage**: all new persistent state must use an explicit `DataKey` variant. Document the key in the storage layout table in `lib.rs`.
- **Events**: emit a contract event for every state-changing operation so callers can observe changes without polling storage.

#### Linting / formatting commands

```bash
cd contracts/onboarding-bridge
cargo fmt
cargo clippy -- -D warnings
```

---

## Testing Expectations

Every PR that adds behaviour must include tests. The bar:

| Tier | What it covers | Required for |
|------|---------------|-------------|
| **Unit** | Single function / module in isolation | All new functions |
| **Integration** | Multiple modules or API endpoint | New API endpoints, service interactions |
| **E2E** | Full request flow through a running server | Critical user paths (`/fund`, `/quote`) |
| **Contract (Rust)** | On-chain logic via `soroban-sdk` testutils | Any contract change |
| **Fuzz** (contract) | Input invariants (amounts, addresses) | Parsing or arithmetic changes |

### TypeScript

Tests live alongside the code or in `tests/` subdirectories. The test runner is Vitest.

```bash
# Unit + integration tests
npm run test --workspaces

# E2E (requires running API server or mocks)
npx vitest run --config vitest.e2e.config.ts   # from api/

# Watch mode
npx vitest --watch
```

**Minimum coverage expectations** (not enforced by CI today, but expected in PRs):
- New files: aim for ≥80% line coverage on business logic.
- Bug fixes: must include a regression test that would have caught the bug.

**Test quality rules:**
- Tests must be deterministic (no `Math.random()`, no real network calls unless tagged integration/e2e).
- Mock external dependencies (`soroban.ts`, `moonpay.ts`, `transak.ts`) with `vi.mock()`.
- Use descriptive test names: `it('rejects fund requests with amounts below minimum')` not `it('works')`.
- Group related tests in `describe` blocks matching the module or function under test.

### Rust

```bash
cd contracts/onboarding-bridge
cargo test

# With snapshot tests
cargo test -- --include-ignored
```

- Every new `#[contractimpl]` method needs at least one test exercising the happy path.
- Error paths (panics, auth failures) need explicit tests using `should_panic` or `expect_err`.
- Use the `testutils` feature (`soroban-sdk = { features = ["testutils"] }`) — never write tests that depend on actual network state.

---

## Documentation Requirements

### When to update docs

| Change | Required update |
|--------|----------------|
| New API endpoint | `docs/api-reference/openapi.json`, SDK `BridgeClient`, README API Reference |
| Changed endpoint behaviour | Same as above + `CHANGELOG.md` |
| New env var | `.env.example`, README Environment Variables table |
| New contract function | `contracts/onboarding-bridge/UPGRADE.md`, README Contract Interface table |
| New database migration | `api/src/migrations/` + migration listed in `docs/database.md` |
| Architecture decision | New ADR in `docs/adr/` using `docs/adr/template.md` |
| Security change | `docs/security/threat-model.md` review, `SECURITY.md` known issues if applicable |

### JSDoc / Rust doc comments

All exported TypeScript functions and public Rust functions must have documentation comments:

```typescript
/**
 * Calculates the fee for a given amount in stroops.
 *
 * @param amount - The gross transfer amount in stroops.
 * @param feeBps - The fee rate in basis points (1 bps = 0.01%).
 * @returns The fee amount in stroops (floored to integer).
 */
export function calculateFee(amount: bigint, feeBps: number): bigint { ... }
```

```rust
/// Routes funds from a G-address to a C-address, deducting the protocol fee.
///
/// # Panics
/// - If `amount` is zero or negative.
/// - If `target` is not a contract address (C...).
/// - If the contract is paused.
pub fn fund_c_address(...) -> i128 { ... }
```

---

## Opening a Pull Request

1. **Fork and branch**: create your branch from `main` using the naming convention above.
2. **Keep PRs focused**: one logical change per PR. Split large features into a stack of smaller PRs if possible.
3. **Fill in the PR template**: every section is there for a reason. "See code" or empty descriptions delay review.
4. **Self-review first**: go through the checklist in the template before requesting review. Catch the obvious issues yourself.
5. **Link the issue**: use `Closes #N` in the PR description or footer.
6. **Draft PRs**: use GitHub's draft status for work-in-progress. Request review only when you're confident the PR is ready.
7. **CI must be green**: do not request review on a PR with failing CI. Fix CI failures first.

### PR Size Guidelines

| Size | Lines changed | Expectation |
|------|--------------|-------------|
| Small | < 200 | Review same day |
| Medium | 200–500 | Review within 2 days |
| Large | 500–1000 | Split if possible; expect 3–5 days |
| Extra-large | > 1000 | Requires pre-discussion; likely needs splitting |

---

## Code Review Process

### For authors

- Respond to review comments within **2 business days**. If you need more time, say so.
- Address every comment — either fix it or explain why you disagree. Don't silently ignore feedback.
- Mark resolved threads as resolved only after the fix is pushed.
- Re-request review after pushing a significant revision.
- Avoid force-pushing after review has started (it breaks the diff history). Amend only unpushed commits or before review begins.

### For reviewers

**Turnaround expectations**:

| PR size | First review | Follow-up review |
|---------|-------------|-----------------|
| Small / Medium | 1 business day | Same day |
| Large | 2 business days | 1 business day |

**What to focus on** (roughly in priority order):

1. **Correctness** — does the code do what it says? Are edge cases handled?
2. **Security** — are inputs validated? Are secrets protected? Is auth enforced?
3. **Tests** — are the tests actually testing the right things?
4. **Design** — is the approach consistent with existing patterns and ADRs?
5. **Style** — naming, formatting, comments. Flag these as `nit:` to signal low priority.

**Comment conventions**:

- `nit:` — minor style suggestion; author may choose to ignore.
- `q:` — question, not a blocker; just seeking understanding.
- `blocking:` — must be addressed before approval.
- `suggestion:` — take it or leave it; explain your preference.

**Approval rules**: PRs require **1 approval** from a maintainer. Contract changes require **2 approvals**. Security-sensitive changes (auth middleware, webhook verification, rate limiting) require review from the security lead or a maintainer with security background.

Do not approve your own PR.

---

## Review Checklist

The PR template embeds the full checklist. This is the abridged version for quick reference:

### Every PR
- [ ] No `console.log`, `dbg!`, `println!` left in
- [ ] No new `any` types
- [ ] All new behaviour has tests
- [ ] Error paths are tested
- [ ] No hardcoded secrets or addresses

### API changes
- [ ] OpenAPI spec updated
- [ ] SDK updated if endpoint added/changed
- [ ] Migration script provided for schema changes

### Contract changes
- [ ] `require_auth()` called on all privileged functions
- [ ] New storage keys added to `DataKey` enum and documented
- [ ] Event emitted for all state changes
- [ ] `UPGRADE.md` updated

### Security-sensitive changes
- [ ] Sensitive values not logged
- [ ] Auth enforced on new endpoints
- [ ] Input validated with Zod (TypeScript) or assertions (Rust)

### Documentation
- [ ] JSDoc / `///` on all public functions
- [ ] Env vars added to `.env.example` and README
- [ ] `CHANGELOG.md` entry for user-facing changes

---

## Escalation Path

If a PR is stuck, use this path:

1. **Ping in the PR** after the expected turnaround time has passed. A `@mention` in a comment is fine.
2. **Slack channel** (`#c-address-bridge` on the Stellar Wave Discord) — post a link and ask for review.
3. **Maintainer escalation** — if a PR has had no response for more than 5 business days, tag a project maintainer directly.
4. **Design disagreement** — if an author and reviewer cannot resolve a disagreement after two rounds, escalate to a third maintainer for a deciding opinion. The goal is a quick, documented decision, not consensus by attrition.

For urgent security fixes (active vulnerability), skip the queue: flag it in Slack as `[SECURITY]` and it will be prioritised for same-day review.

---

## Need Help?

- **Discord**: [Stellar Wave Discord](https://discord.gg/stellar-wave) → `#c-address-bridge`
- **GitHub Discussions**: for design questions and RFC-style proposals
- **Issues**: for bugs and concrete feature requests
