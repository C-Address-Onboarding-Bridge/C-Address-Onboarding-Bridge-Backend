import { Migration } from './runner';

export const migration002: Migration = {
  version: '002',
  name: 'api_keys_schema',

  async up() {
    const schema = `
      CREATE TABLE IF NOT EXISTS api_keys (
        id            TEXT PRIMARY KEY,
        key_hash      TEXT UNIQUE NOT NULL,
        name          TEXT NOT NULL,
        created_by    TEXT NOT NULL,
        created_at    BIGINT NOT NULL,
        updated_at    BIGINT NOT NULL,
        last_used_at  BIGINT,
        scopes        TEXT NOT NULL,
        ip_whitelist  TEXT NOT NULL DEFAULT '[]',
        expires_at    BIGINT,
        rate_limit    TEXT NOT NULL DEFAULT 'standard',
        revoked       INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_api_keys_hash    ON api_keys (key_hash);
      CREATE INDEX IF NOT EXISTS idx_api_keys_revoked ON api_keys (revoked);

      CREATE TABLE IF NOT EXISTS api_key_audit_log (
        id        TEXT PRIMARY KEY,
        key_id    TEXT NOT NULL REFERENCES api_keys(id),
        ip        TEXT NOT NULL,
        path      TEXT NOT NULL,
        method    TEXT NOT NULL,
        ts        BIGINT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_audit_key_id ON api_key_audit_log (key_id);
    `;
    console.log('[migration 002] api_keys schema ready (no DB client attached; DDL logged for reference)');
    console.log(schema);
  },

  async down() {
    const rollback = `
      DROP INDEX IF EXISTS idx_audit_key_id;
      DROP TABLE IF EXISTS api_key_audit_log;
      DROP INDEX IF EXISTS idx_api_keys_revoked;
      DROP INDEX IF EXISTS idx_api_keys_hash;
      DROP TABLE IF EXISTS api_keys;
    `;
    console.log('[migration 002] rollback DDL (no DB client attached; DDL logged for reference)');
    console.log(rollback);
  },
};
