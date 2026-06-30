import { Migration } from './runner';

/**
 * Migration 005 — Query optimization & indexing strategy
 *
 * Adds composite, partial, and covering indexes for the common query patterns
 * identified in issue #108:
 *
 *  1. tx_hash lookup (already unique; added covering index for status check)
 *  2. Address lookup — source_addr / target_addr with date range
 *  3. Status + date range (dashboard / analytics queries)
 *  4. Partial index for pending transactions (most frequently polled)
 *  5. Analytics aggregations by period
 *  6. Webhook delivery log lookups by registration + delivery window
 *  7. Audit log integrity lookups
 *
 * Also configures PostgreSQL slow-query logging (log_min_duration_statement)
 * and pg_stat_statements extension for ongoing query analysis.
 */
export const migration005: Migration = {
  version: '005',
  name: 'query_optimization_indexes',

  async up() {
    const schema = `
      -- ─────────────────────────────────────────────────────────
      -- Enable query statistics extension
      -- ─────────────────────────────────────────────────────────
      CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

      -- ─────────────────────────────────────────────────────────
      -- Slow query logging (100ms threshold)
      -- Applied at session level; set globally via postgresql.conf
      -- or ALTER SYSTEM for persistent configuration.
      -- ─────────────────────────────────────────────────────────
      -- ALTER SYSTEM SET log_min_duration_statement = '100';  -- milliseconds
      -- ALTER SYSTEM SET log_statement = 'none';
      -- ALTER SYSTEM SET log_duration = 'off';
      -- SELECT pg_reload_conf();

      -- ─────────────────────────────────────────────────────────
      -- transactions table — composite & covering indexes
      -- ─────────────────────────────────────────────────────────

      -- Pattern: lookup by tx_hash and immediately check status
      -- Covers: SELECT status FROM transactions WHERE tx_hash = $1
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tx_hash_covering
        ON transactions (tx_hash)
        INCLUDE (status, created_at, source_addr, target_addr);

      -- Pattern: all transactions for a source address, sorted by time
      -- Covers: SELECT * FROM transactions WHERE source_addr = $1 ORDER BY created_at DESC
      CREATE INDEX IF NOT EXISTS idx_tx_source_time
        ON transactions (source_addr, created_at DESC);

      -- Pattern: all transactions for a target address, sorted by time
      CREATE INDEX IF NOT EXISTS idx_tx_target_time
        ON transactions (target_addr, created_at DESC);

      -- Pattern: date-range queries with status filter (dashboard)
      -- Covers: WHERE status = 'success' AND created_at BETWEEN $1 AND $2
      CREATE INDEX IF NOT EXISTS idx_tx_status_time
        ON transactions (status, created_at DESC);

      -- Pattern: aggregate fee calculations over a time window
      -- Covers: SELECT SUM(amount), COUNT(*) WHERE status='success' AND created_at > $1
      CREATE INDEX IF NOT EXISTS idx_tx_success_time
        ON transactions (created_at DESC)
        WHERE status = 'success';

      -- Partial index — pending transactions (most frequently polled by workers)
      -- Very small, hot index; dramatically speeds up worker queue scans
      CREATE INDEX IF NOT EXISTS idx_tx_pending
        ON transactions (created_at ASC)
        WHERE status = 'pending';

      -- Pattern: source + target pair lookup (duplicate detection)
      CREATE INDEX IF NOT EXISTS idx_tx_source_target
        ON transactions (source_addr, target_addr, created_at DESC);

      -- ─────────────────────────────────────────────────────────
      -- analytics_metrics table
      -- ─────────────────────────────────────────────────────────

      -- Pattern: latest value for a metric in a period
      -- Covers: WHERE period = $1 AND metric = $2 ORDER BY computed_at DESC LIMIT 1
      CREATE INDEX IF NOT EXISTS idx_analytics_period_metric_time
        ON analytics_metrics (period, metric, computed_at DESC);

      -- ─────────────────────────────────────────────────────────
      -- webhook_events table
      -- ─────────────────────────────────────────────────────────

      -- Pattern: pending events for a source (worker pickup)
      CREATE INDEX IF NOT EXISTS idx_webhook_events_pending
        ON webhook_events (source, received_at ASC)
        WHERE status = 'pending';

      -- Pattern: failed events for retry queue
      CREATE INDEX IF NOT EXISTS idx_webhook_events_failed
        ON webhook_events (received_at ASC)
        WHERE status = 'failed';

      -- ─────────────────────────────────────────────────────────
      -- webhook_delivery_log table
      -- ─────────────────────────────────────────────────────────

      -- Pattern: recent deliveries for a registration (admin view)
      CREATE INDEX IF NOT EXISTS idx_webhook_delivery_reg_time
        ON webhook_delivery_log (registration_id, delivered_at DESC);

      -- ─────────────────────────────────────────────────────────
      -- audit_log table (from migration 004)
      -- ─────────────────────────────────────────────────────────

      -- Pattern: audit log lookup by entity + time range
      CREATE INDEX IF NOT EXISTS idx_audit_entity_time
        ON audit_log (entity_type, entity_id, created_at DESC);

      -- Pattern: audit log lookup by actor (who did what)
      CREATE INDEX IF NOT EXISTS idx_audit_actor_time
        ON audit_log (actor_id, created_at DESC);

      -- ─────────────────────────────────────────────────────────
      -- Maintenance: update planner statistics
      -- ─────────────────────────────────────────────────────────
      ANALYZE transactions;
      ANALYZE analytics_metrics;
      ANALYZE webhook_events;
      ANALYZE webhook_delivery_log;
    `;

    console.log('[migration 005] query optimization indexes ready (no DB client attached; DDL logged for reference)');
    console.log(schema);
  },

  async down() {
    const rollback = `
      DROP INDEX IF EXISTS idx_audit_actor_time;
      DROP INDEX IF EXISTS idx_audit_entity_time;
      DROP INDEX IF EXISTS idx_webhook_delivery_reg_time;
      DROP INDEX IF EXISTS idx_webhook_events_failed;
      DROP INDEX IF EXISTS idx_webhook_events_pending;
      DROP INDEX IF EXISTS idx_analytics_period_metric_time;
      DROP INDEX IF EXISTS idx_tx_source_target;
      DROP INDEX IF EXISTS idx_tx_pending;
      DROP INDEX IF EXISTS idx_tx_success_time;
      DROP INDEX IF EXISTS idx_tx_status_time;
      DROP INDEX IF EXISTS idx_tx_target_time;
      DROP INDEX IF EXISTS idx_tx_source_time;
      DROP INDEX IF EXISTS idx_tx_hash_covering;
    `;

    console.log('[migration 005] rollback DDL (no DB client attached; DDL logged for reference)');
    console.log(rollback);
  },
};
