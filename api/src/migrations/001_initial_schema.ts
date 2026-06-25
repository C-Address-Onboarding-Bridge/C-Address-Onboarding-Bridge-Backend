import { Migration } from './runner';

export const migration001: Migration = {
  version: '001',
  name: 'initial_schema',

  async up() {
    // When a real database client is wired in, execute DDL here.
    // Placeholder documents the intended schema for the bridge backend.
    const schema = `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        applied_at  BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS transactions (
        id            TEXT PRIMARY KEY,
        tx_hash       TEXT UNIQUE NOT NULL,
        status        TEXT NOT NULL CHECK (status IN ('pending','success','failed')),
        source_addr   TEXT NOT NULL,
        target_addr   TEXT NOT NULL,
        token_addr    TEXT NOT NULL,
        amount        TEXT NOT NULL,
        fee_bps       INTEGER NOT NULL DEFAULT 30,
        explorer_url  TEXT,
        created_at    BIGINT NOT NULL,
        updated_at    BIGINT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_transactions_status   ON transactions (status);
      CREATE INDEX IF NOT EXISTS idx_transactions_hash     ON transactions (tx_hash);
      CREATE INDEX IF NOT EXISTS idx_transactions_source   ON transactions (source_addr);

      CREATE TABLE IF NOT EXISTS webhook_registrations (
        id          TEXT PRIMARY KEY,
        api_key     TEXT NOT NULL,
        url         TEXT NOT NULL,
        secret_hash TEXT NOT NULL,
        events      TEXT NOT NULL,
        created_at  BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS webhook_delivery_log (
        id              TEXT PRIMARY KEY,
        registration_id TEXT NOT NULL REFERENCES webhook_registrations(id),
        event           TEXT NOT NULL,
        attempt_number  INTEGER NOT NULL,
        status_code     INTEGER,
        error           TEXT,
        delivered_at    BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS webhook_dlq (
        id              TEXT PRIMARY KEY,
        registration_id TEXT NOT NULL,
        event           TEXT NOT NULL,
        payload         TEXT NOT NULL,
        failed_at       BIGINT NOT NULL
      );
    `;
    console.log('[migration 001] schema ready (no DB client attached; DDL logged for reference)');
    console.log(schema);
  },

  async down() {
    const rollback = `
      DROP TABLE IF EXISTS webhook_dlq;
      DROP TABLE IF EXISTS webhook_delivery_log;
      DROP TABLE IF EXISTS webhook_registrations;
      DROP INDEX IF EXISTS idx_transactions_source;
      DROP INDEX IF EXISTS idx_transactions_hash;
      DROP INDEX IF EXISTS idx_transactions_status;
      DROP TABLE IF EXISTS transactions;
      DROP TABLE IF EXISTS schema_migrations;
    `;
    console.log('[migration 001] rollback DDL (no DB client attached; DDL logged for reference)');
    console.log(rollback);
  },
};
