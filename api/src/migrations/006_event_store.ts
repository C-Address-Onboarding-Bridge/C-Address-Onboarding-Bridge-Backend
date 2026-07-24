import { Migration } from './runner';

export const migration006: Migration = {
  version: '006',
  name: 'event_store',

  async up() {
    const schema = `
      CREATE TABLE IF NOT EXISTS event_store (
        sequence     BIGSERIAL PRIMARY KEY,
        event_id     TEXT UNIQUE NOT NULL,
        event_type   TEXT NOT NULL,
        payload      TEXT NOT NULL,
        created_at   BIGINT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_event_store_type ON event_store (event_type);
      CREATE INDEX IF NOT EXISTS idx_event_store_created ON event_store (created_at);

      CREATE TABLE IF NOT EXISTS event_dlq (
        id           TEXT PRIMARY KEY,
        event_type   TEXT NOT NULL,
        payload      TEXT NOT NULL,
        error        TEXT NOT NULL,
        failed_at    BIGINT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_event_dlq_type ON event_dlq (event_type);
    `;
    console.log('[migration 006] event_store schema ready (no DB client attached; DDL logged for reference)');
    console.log(schema);
  },

  async down() {
    const rollback = `
      DROP INDEX IF EXISTS idx_event_dlq_type;
      DROP TABLE IF EXISTS event_dlq;
      DROP INDEX IF EXISTS idx_event_store_created;
      DROP INDEX IF EXISTS idx_event_store_type;
      DROP TABLE IF EXISTS event_store;
    `;
    console.log('[migration 006] rollback DDL (no DB client attached; DDL logged for reference)');
    console.log(rollback);
  },
};
