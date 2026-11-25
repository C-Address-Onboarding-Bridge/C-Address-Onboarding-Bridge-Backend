import { Migration, runDDL } from './runner';

/**
 * Migration 007: extend audit_log_entries.event_type CHECK constraint to cover
 * every AuditEventType value the application writes.
 *
 * The original constraint in migration 004 only listed five values, but the
 * API appends several more (transaction_prepared, batch_transaction_submission_result,
 * timelocked_transaction_submission_result, timelocked_claim_result,
 * direct_transaction_submission_result). Those inserts violated the constraint
 * and were silently swallowed, causing the in-memory hash chain to diverge from
 * the persisted table. Closes #907.
 */
export const migration007: Migration = {
  version: '007',
  name: 'audit_log_event_types',

  async up() {
    const schema = `
      ALTER TABLE audit_log_entries
        DROP CONSTRAINT IF EXISTS audit_log_entries_event_type_check;

      ALTER TABLE audit_log_entries
        ADD CONSTRAINT audit_log_entries_event_type_check
          CHECK (event_type IN (
            'transaction_submission',
            'transaction_submission_result',
            'transaction_prepared',
            'batch_transaction_submission_result',
            'timelocked_transaction_submission_result',
            'timelocked_claim_result',
            'direct_transaction_submission_result',
            'fee_withdrawal',
            'admin_operation',
            'webhook_delivery'
          ));
    `;
    await runDDL(schema);
  },

  async down() {
    const rollback = `
      ALTER TABLE audit_log_entries
        DROP CONSTRAINT IF EXISTS audit_log_entries_event_type_check;

      ALTER TABLE audit_log_entries
        ADD CONSTRAINT audit_log_entries_event_type_check
          CHECK (event_type IN (
            'transaction_submission',
            'transaction_submission_result',
            'fee_withdrawal',
            'admin_operation',
            'webhook_delivery'
          ));
    `;
    await runDDL(rollback);
  },
};
