import { Migration, runDDL } from './runner';

export const migration006: Migration = {
  version: '006',
  name: 'provider_orders',

  async up() {
    const schema = `
      CREATE TABLE IF NOT EXISTS provider_orders (
        id              TEXT PRIMARY KEY,
        provider        TEXT NOT NULL CHECK (provider IN ('moonpay', 'transak')),
        status          TEXT NOT NULL,
        amount          NUMERIC(20, 8),
        currency        TEXT,
        wallet_address  TEXT,
        user_id         TEXT,
        created_at      BIGINT NOT NULL,
        updated_at      BIGINT NOT NULL,
        completed_at    BIGINT,
        payload         JSONB NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_provider_orders_provider_created
        ON provider_orders (provider, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_provider_orders_user_created
        ON provider_orders (user_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_provider_orders_wallet
        ON provider_orders (wallet_address);
    `;
    await runDDL(schema);
  },

  async down() {
    const rollback = `
      DROP INDEX IF EXISTS idx_provider_orders_wallet;
      DROP INDEX IF EXISTS idx_provider_orders_user_created;
      DROP INDEX IF EXISTS idx_provider_orders_provider_created;
      DROP TABLE IF EXISTS provider_orders;
    `;
    await runDDL(rollback);
  },
};
