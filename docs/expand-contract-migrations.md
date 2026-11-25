# Expand/contract database migrations

Deploys run `npm run migrate -w api` **before** traffic moves to the new
blue/green color. While the new color warms up, the old color is still serving
requests against the migrated schema. So every migration has to work with
**both** the previous and the new release.

## Rules

1. **Expand** (any release): `CREATE TABLE`, `ADD COLUMN` (nullable or with a
   default), new indexes, backfills. The previous release ignores what it does
   not know about.
2. **Contract** (a *later* release, after nothing running still uses the old
   shape): `DROP TABLE`, `DROP COLUMN`, `RENAME`, column type changes,
   `SET NOT NULL`, `TRUNCATE`.

To rename `a` to `b`: add `b` and dual-write in release N, backfill and switch
reads to `b` in release N+1, then drop `a` in a contract migration in release N+2.

## Enforcement

`scripts/check-expand-only-migrations.mjs` runs before `migrate` in every
deploy job (and in the *Deploy scripts* workflow on PRs). It fails when a
migration's `up()` contains a destructive statement. A deliberate contract
migration opts out by including this comment:

```ts
// migration-phase: contract
```

`down()` is not checked, because rollbacks are expected to drop what `up()` added.

## Rollback

`scripts/deploy-api.sh --rollback` restores the previous image by registry
digest. It does **not** roll the schema back. Expand-only migrations are what
make that safe: the previous image still works against the expanded schema.
