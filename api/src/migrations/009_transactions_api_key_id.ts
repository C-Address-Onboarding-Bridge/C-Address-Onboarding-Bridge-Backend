import { Migration, runDDL } from './runner';

/**
 * Migration 009 — Track the creating API key on transactions so the
 * DB-backed listTransactions can enforce tenant scoping (apiKeyId filter).
 * Existing rows are attributed to 'legacy'.
 */
export const migration009: Migration = {
  version: '009',
  name: 'transactions_api_key_id',

  async up() {
    await runDDL(`
      ALTER TABLE transactions ADD COLUMN IF NOT EXISTS api_key_id TEXT NOT NULL DEFAULT 'legacy';
      CREATE INDEX IF NOT EXISTS idx_transactions_api_key_id ON transactions (api_key_id);
    `);
  },

  async down() {
    await runDDL(`
      DROP INDEX IF EXISTS idx_transactions_api_key_id;
      ALTER TABLE transactions DROP COLUMN IF EXISTS api_key_id;
    `);
  },
};
