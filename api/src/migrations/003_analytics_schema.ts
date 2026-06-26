import { Migration } from './runner';

export const migration003: Migration = {
  version: '003',
  name: 'analytics_schema',

  async up() {
    const schema = `
      CREATE TABLE IF NOT EXISTS webhook_events (
        id          TEXT PRIMARY KEY,
        source      TEXT NOT NULL,
        event_type  TEXT NOT NULL,
        payload     TEXT NOT NULL,
        received_at BIGINT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processed','failed'))
      );

      CREATE INDEX IF NOT EXISTS idx_webhook_events_source ON webhook_events (source);
      CREATE INDEX IF NOT EXISTS idx_webhook_events_status ON webhook_events (status);

      CREATE TABLE IF NOT EXISTS analytics_metrics (
        id          TEXT PRIMARY KEY,
        period      TEXT NOT NULL,
        metric      TEXT NOT NULL,
        value       NUMERIC NOT NULL,
        computed_at BIGINT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_analytics_period_metric ON analytics_metrics (period, metric);
    `;
    console.log('[migration 003] analytics schema ready (no DB client attached; DDL logged for reference)');
    console.log(schema);
  },

  async down() {
    const rollback = `
      DROP INDEX IF EXISTS idx_analytics_period_metric;
      DROP TABLE IF EXISTS analytics_metrics;
      DROP INDEX IF EXISTS idx_webhook_events_status;
      DROP INDEX IF EXISTS idx_webhook_events_source;
      DROP TABLE IF EXISTS webhook_events;
    `;
    console.log('[migration 003] rollback DDL (no DB client attached; DDL logged for reference)');
    console.log(rollback);
  },
};
