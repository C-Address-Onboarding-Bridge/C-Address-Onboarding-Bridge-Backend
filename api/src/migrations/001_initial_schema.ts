import type { PoolClient } from 'pg';
import { Migration, runDDLOnClient } from './runner';

export const migration001: Migration = {
  version: '001',
  name: 'initial_schema',

  async up(client: PoolClient) {
    // schema_migrations is created by the runner's ensureTable() — do not
    // recreate it here to avoid conflicts with the advisory-locked transaction.
    const schema = `
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
        url         TEXT NOT NULL,
        secret      TEXT NOT NULL,
        events      TEXT[] NOT NULL DEFAULT '{}',
        active      BOOLEAN NOT NULL DEFAULT TRUE,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS webhook_delivery_log (
        id               TEXT PRIMARY KEY,
        registration_id  TEXT NOT NULL REFERENCES webhook_registrations(id),
        event            TEXT NOT NULL,
        status           TEXT NOT NULL,
        attempts         INTEGER NOT NULL DEFAULT 0,
        response_status  INTEGER,
        error            TEXT,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS webhook_delivery_log_created_at_idx
        ON webhook_delivery_log (created_at);

      CREATE TABLE IF NOT EXISTS webhook_dlq (
        id               TEXT PRIMARY KEY,
        registration_id  TEXT NOT NULL,
        event            TEXT NOT NULL,
        payload          JSONB NOT NULL,
        attempts         INTEGER NOT NULL DEFAULT 0,
        last_error       TEXT,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `;
    await runDDLOnClient(schema, client);
  },

  async down(client: PoolClient) {
    const rollback = `
      DROP TABLE IF EXISTS webhook_dlq;
      DROP INDEX IF EXISTS webhook_delivery_log_created_at_idx;
      DROP TABLE IF EXISTS webhook_delivery_log;
      DROP TABLE IF EXISTS webhook_registrations;
      DROP INDEX IF EXISTS idx_transactions_source;
      DROP INDEX IF EXISTS idx_transactions_hash;
      DROP INDEX IF EXISTS idx_transactions_status;
      DROP TABLE IF EXISTS transactions;
    `;
    await runDDLOnClient(rollback, client);
  },
};
