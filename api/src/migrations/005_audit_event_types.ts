import { Migration, runDDL } from './runner';

const EVENT_TYPES = [
  'transaction_submission',
  'transaction_submission_result',
  'transaction_prepared',
  'batch_transaction_submission_result',
  'timelocked_transaction_submission_result',
  'timelocked_claim_result',
  'direct_transaction_submission_result',
  'fee_withdrawal',
  'admin_operation',
  'webhook_delivery',
  'server_start',
] as const;

export const migration005: Migration = {
  version: '005',
  name: 'audit_event_types',

  async up() {
    const list = EVENT_TYPES.map((t) => `'${t}'`).join(',\n          ');
    const schema = `
      ALTER TABLE audit_log_entries
        DROP CONSTRAINT IF EXISTS audit_log_entries_event_type_check;

      ALTER TABLE audit_log_entries
        ADD CONSTRAINT audit_log_entries_event_type_check
        CHECK (event_type IN (
          ${list}
        ));
    `;
    await runDDL(schema);
  },

  async down() {
    // Restore the original 004 constraint set.
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
