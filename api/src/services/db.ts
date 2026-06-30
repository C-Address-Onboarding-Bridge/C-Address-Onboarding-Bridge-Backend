import { Pool, PoolClient } from 'pg';
import { Gauge } from 'prom-client';
import { config } from '../config';
import { logger } from '../logger';
import { register } from './metrics';

let pool: Pool | null = null;

export function getPool(): Pool | null {
  if (!config.database.url) return null;
  if (pool) return pool;

  pool = new Pool({
    connectionString: config.database.url,
    min: config.database.poolMin,
    max: config.database.poolMax,
    idleTimeoutMillis: config.database.idleTimeoutMs,
    connectionTimeoutMillis: config.database.connectionTimeoutMs,
    statement_timeout: config.database.statementTimeoutMs,
    ssl: config.database.ssl ? { rejectUnauthorized: false } : false,
  });

  pool.on('error', (err) => {
    logger.error({ err }, 'postgres pool error');
  });

  return pool;
}

export interface PoolMetrics {
  /** Total connections in the pool (idle + active). */
  total: number;
  /** Idle connections available for checkout. */
  idle: number;
  /** Connections currently checked out and in use. */
  active: number;
  /** Queued requests waiting for a free connection. */
  waiting: number;
}

/** Live snapshot of the PostgreSQL pool, or null when the DB is not configured. */
export function getPoolMetrics(): PoolMetrics | null {
  if (!pool) return null;
  const total = pool.totalCount;
  const idle = pool.idleCount;
  return { total, idle, active: total - idle, waiting: pool.waitingCount };
}

// ─── Pool metrics ──────────────────────────────────────────────────────────────
// Sampled on every scrape via collect() so values are always current without a
// background timer. No-op while the database is unconfigured.

const dbPoolActive = new Gauge({
  name: 'db_pool_connections_active',
  help: 'Active (checked-out) PostgreSQL pool connections',
  registers: [register],
});

const dbPoolIdle = new Gauge({
  name: 'db_pool_connections_idle',
  help: 'Idle PostgreSQL pool connections',
  registers: [register],
});

const dbPoolWaiting = new Gauge({
  name: 'db_pool_waiting_requests',
  help: 'Requests waiting for a free PostgreSQL connection',
  registers: [register],
});

new Gauge({
  name: 'db_pool_connections_total',
  help: 'Total PostgreSQL pool connections (idle + active)',
  registers: [register],
  collect() {
    const m = getPoolMetrics();
    if (!m) return;
    this.set(m.total);
    dbPoolActive.set(m.active);
    dbPoolIdle.set(m.idle);
    dbPoolWaiting.set(m.waiting);
  },
});

export async function dbHealthCheck(): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
  const p = getPool();
  if (!p) return { ok: true };

  const start = Date.now();
  let client: PoolClient | undefined;
  try {
    client = await p.connect();
    await client.query('SELECT 1');
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return { ok: false, error: String(err), latencyMs: Date.now() - start };
  } finally {
    client?.release();
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
