import { Migration } from './runner';

export const migration004: Migration = {
  version: '004',
  name: 'integrity_audit_log',

  async up() {
    const schema = `
      CREATE TABLE IF NOT EXISTS audit_log_entries (
        sequence        BIGINT PRIMARY KEY,
        id              TEXT UNIQUE NOT NULL,
        event_type      TEXT NOT NULL CHECK (event_type IN (
          'transaction_submission',
          'transaction_submission_result',
          'fee_withdrawal',
          'admin_operation',
          'webhook_delivery'
        )),
        actor           TEXT NOT NULL,
        payload         TEXT NOT NULL,
        previous_hash   TEXT NOT NULL,
        hash            TEXT UNIQUE NOT NULL,
        created_at      BIGINT NOT NULL,
        retention_until BIGINT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_audit_log_event_type_created
        ON audit_log_entries (event_type, created_at);

      CREATE INDEX IF NOT EXISTS idx_audit_log_actor_created
        ON audit_log_entries (actor, created_at);

      CREATE TABLE IF NOT EXISTS audit_log_checkpoints (
        sequence        BIGINT PRIMARY KEY REFERENCES audit_log_entries(sequence),
        hash            TEXT NOT NULL,
        published_at    BIGINT NOT NULL,
        publisher       TEXT NOT NULL,
        publication_ref TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_audit_log_checkpoints_hash
        ON audit_log_checkpoints (hash);
    `;
    console.log('[migration 004] integrity audit log schema ready (no DB client attached; DDL logged for reference)');
    console.log(schema);
  },

  async down() {
    const rollback = `
      DROP INDEX IF EXISTS idx_audit_log_checkpoints_hash;
      DROP TABLE IF EXISTS audit_log_checkpoints;
      DROP INDEX IF EXISTS idx_audit_log_actor_created;
      DROP INDEX IF EXISTS idx_audit_log_event_type_created;
      DROP TABLE IF EXISTS audit_log_entries;
    `;
    console.log('[migration 004] rollback DDL (no DB client attached; DDL logged for reference)');
    console.log(rollback);
  },
};
