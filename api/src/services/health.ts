import { dbHealthCheck } from './db';
import { config } from '../config';
import { logger } from '../logger';

interface DependencyCheck {
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

interface HealthResult {
  status: 'ok' | 'degraded' | 'unhealthy';
  timestamp: number;
  version: string;
  dependencies: Record<string, DependencyCheck & { critical: boolean }>;
}

let cachedResult: HealthResult | null = null;
let cacheExpiresAt = 0;
const CACHE_TTL_MS = 5000;

async function checkSoroban(): Promise<DependencyCheck> {
  const start = Date.now();
  try {
    const url = config.soroban.rpcUrls[0];
    if (!url) return { ok: false, error: 'no rpc url configured' };

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getNetwork', params: [] }),
      signal: AbortSignal.timeout(3000),
    });
    return { ok: res.ok || res.status < 500, latencyMs: Date.now() - start };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - start, error: String(err) };
  }
}

async function checkRedis(): Promise<DependencyCheck> {
  if (!config.redis.enabled) return { ok: true, error: undefined };
  const start = Date.now();
  try {
    const { default: Redis } = await import('ioredis');
    const client = new Redis(config.redis.url, {
      lazyConnect: true,
      maxRetriesPerRequest: 0,
      connectTimeout: 2000,
      enableOfflineQueue: false,
    });
    await client.connect();
    await client.ping();
    await client.quit();
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - start, error: String(err) };
  }
}

export async function getHealthStatus(force = false): Promise<HealthResult> {
  const now = Date.now();
  if (!force && cachedResult && now < cacheExpiresAt) {
    return cachedResult;
  }

  const version = process.env.npm_package_version ?? (config.logging as { version?: string }).version ?? '0.1.0';

  const [soroban, database, redis] = await Promise.allSettled([
    checkSoroban(),
    dbHealthCheck(),
    checkRedis(),
  ]);

  const resolve = (r: PromiseSettledResult<DependencyCheck>): DependencyCheck =>
    r.status === 'fulfilled' ? r.value : { ok: false, error: String(r.reason) };

  const deps = {
    soroban: { ...resolve(soroban), critical: true },
    database: { ...resolve(database), critical: false },
    redis: { ...resolve(redis), critical: false },
  };

  const criticalFailed = Object.values(deps).some((d) => d.critical && !d.ok);
  const anyFailed = Object.values(deps).some((d) => d.critical && !d.ok || (!d.critical && !d.ok && d.error !== undefined));

  const result: HealthResult = {
    status: criticalFailed ? 'unhealthy' : anyFailed ? 'degraded' : 'ok',
    timestamp: now,
    version,
    dependencies: deps,
  };

  cachedResult = result;
  cacheExpiresAt = now + CACHE_TTL_MS;
  return result;
}

export function invalidateHealthCache(): void {
  cachedResult = null;
  cacheExpiresAt = 0;
}
