import { Migration, runDDL } from './runner';

/**
 * Migration 007 — Drop indexes made redundant by migration 005 (issue #1071)
 *
 * Migration 005 added composite indexes whose leading columns duplicate
 * single-column indexes from 001 and 004. Every write to `transactions` and
 * `audit_log_entries` maintained both. Applied migrations are not edited, so
 * the duplicates are dropped here. What remains, one index per prefix:
 *
 *  - tx_hash      → the `tx_hash TEXT UNIQUE` constraint index (001). The
 *                   covering `idx_tx_hash_covering` is dropped: its INCLUDE
 *                   columns (status, …) change on every status update, which
 *                   rules out HOT updates for a lookup the constraint index
 *                   already serves.
 *  - source_addr  → `idx_tx_source_time` (005)
 *  - status       → `idx_tx_status_time` (005)
 *  - audit (event_type, created_at) → `idx_audit_log_event_type_created` (004)
 *  - audit (actor, created_at)      → `idx_audit_log_actor_created` (004)
 *
 * B-tree indexes scan in both directions, so `created_at DESC` duplicates of
 * the 004 audit indexes add no query capability.
 */
export const REDUNDANT_INDEXES = [
  'idx_transactions_hash',
  'idx_tx_hash_covering',
  'idx_transactions_source',
  'idx_transactions_status',
  'idx_audit_entity_time',
  'idx_audit_actor_time',
] as const;

export const migration007: Migration = {
  version: '007',
  name: 'drop_redundant_indexes',

  async up() {
    await runDDL(REDUNDANT_INDEXES.map((name) => `DROP INDEX IF EXISTS ${name};`).join('\n'));
  },

  async down() {
    // Recreate the indexes exactly as 001, 004 and 005 defined them.
    await runDDL(`
      CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions (status);
      CREATE INDEX IF NOT EXISTS idx_transactions_hash   ON transactions (tx_hash);
      CREATE INDEX IF NOT EXISTS idx_transactions_source ON transactions (source_addr);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tx_hash_covering
        ON transactions (tx_hash)
        INCLUDE (status, created_at, source_addr, target_addr);
      CREATE INDEX IF NOT EXISTS idx_audit_entity_time
        ON audit_log_entries (event_type, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_actor_time
        ON audit_log_entries (actor, created_at DESC);
    `);
  },
};
