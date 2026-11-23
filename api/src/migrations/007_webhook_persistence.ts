import { Migration, runDDL } from './runner';

export const migration007: Migration = {
  version: '007',
  name: 'webhook_persistence',

  async up() {
    await runDDL(`
      ALTER TABLE webhook_registrations
        ADD COLUMN IF NOT EXISTS api_key_id TEXT,
        ADD COLUMN IF NOT EXISTS secret TEXT;

      CREATE INDEX IF NOT EXISTS idx_webhook_registrations_api_key_id
        ON webhook_registrations (api_key_id);

      ALTER TABLE webhook_delivery_log
        ADD COLUMN IF NOT EXISTS webhook_url TEXT NOT NULL DEFAULT '';

      ALTER TABLE webhook_dlq
        ADD COLUMN IF NOT EXISTS attempts JSONB NOT NULL DEFAULT '[]'::jsonb;
    `);
  },

  async down() {
    await runDDL(`
      ALTER TABLE webhook_dlq DROP COLUMN IF EXISTS attempts;
      ALTER TABLE webhook_delivery_log DROP COLUMN IF EXISTS webhook_url;
      DROP INDEX IF EXISTS idx_webhook_registrations_api_key_id;
      ALTER TABLE webhook_registrations DROP COLUMN IF EXISTS secret;
      ALTER TABLE webhook_registrations DROP COLUMN IF EXISTS api_key_id;
    `);
  },
};
