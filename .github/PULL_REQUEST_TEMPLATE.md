## Summary

<!-- One or two sentences: what does this PR do and why? -->

Fixes # <!-- issue number, if applicable -->

## Type of change

<!-- Check all that apply -->

- [ ] `feat` — new feature
- [ ] `fix` — bug fix
- [ ] `refactor` — code change that neither fixes a bug nor adds a feature
- [ ] `perf` — performance improvement
- [ ] `test` — adding or correcting tests
- [ ] `docs` — documentation only
- [ ] `chore` — build, CI, dependencies, tooling
- [ ] `contract` — Soroban smart contract change

## Changes

<!-- Bullet list of the concrete changes made -->

-

## Testing

<!-- How was this tested? Which test commands were run? -->

- [ ] `cargo test` (contract changes)
- [ ] `npm run test --workspaces`
- [ ] `npm run build` passes without errors
- [ ] Manual testing (describe below if applicable)

```
# paste relevant test output here if it adds context
```

---

## Code Review Checklist

### General

- [ ] Code follows the project's TypeScript / Rust conventions (see `CONTRIBUTING.md`)
- [ ] No `console.log`, `dbg!`, `println!`, or other debug output left in
- [ ] No `TODO` or `FIXME` comments added without a linked issue
- [ ] No new `any` types introduced in TypeScript
- [ ] No new `unsafe` blocks in Rust without documented justification
- [ ] No hardcoded secrets, addresses, or credentials

### Tests

- [ ] New behaviour is covered by unit tests
- [ ] Edge cases and error paths are tested
- [ ] Integration / E2E tests updated if the API contract changed
- [ ] Fuzz targets updated if input parsing changed (contract)

### API & Contract Changes

- [ ] API changes are documented in `docs/api-reference/openapi.json`
- [ ] SDK `BridgeClient` updated if a new endpoint was added
- [ ] Contract interface changes are reflected in `contracts/onboarding-bridge/UPGRADE.md`
- [ ] Database schema changes include a migration script under `api/src/migrations/`
- [ ] Breaking changes noted in the PR description with a migration path

### Security

- [ ] No new secrets or sensitive values logged
- [ ] Authentication / authorization checked on any new or modified endpoints
- [ ] Input validation present for all user-supplied values
- [ ] Rate limiting applied to new high-cost endpoints

### Documentation

- [ ] Public functions / methods have JSDoc (TypeScript) or `///` doc comments (Rust)
- [ ] `README.md` or relevant `docs/` page updated if user-visible behaviour changed
- [ ] `CHANGELOG.md` entry added for user-facing changes (feat / fix / perf / breaking)

---

## Screenshots / recordings

<!-- Optional: attach screenshots for UI-adjacent changes, or terminal output for CLI changes -->

## Additional context

<!-- Anything the reviewer needs to know that isn't obvious from the diff -->
