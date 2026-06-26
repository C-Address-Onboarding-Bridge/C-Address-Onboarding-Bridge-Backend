import { Pool, PoolClient } from 'pg';
import { config } from '../config';
import { logger } from '../logger';

let pool: Pool | null = null;

export function getPool(): Pool | null {
  if (!config.database.url) return null;
  if (pool) return pool;

  pool = new Pool({
    connectionString: config.database.url,
    max: config.database.poolMax,
    idleTimeoutMillis: config.database.idleTimeoutMs,
    connectionTimeoutMillis: config.database.connectionTimeoutMs,
    ssl: config.database.ssl ? { rejectUnauthorized: false } : false,
  });

  pool.on('error', (err) => {
    logger.error({ err }, 'postgres pool error');
  });

  return pool;
}

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
