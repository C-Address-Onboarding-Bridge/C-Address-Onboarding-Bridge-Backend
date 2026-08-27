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

  // Return cached result if still valid and not forced
  if (!force && cachedResult !== null && now < cacheExpiresAt) {
    return cachedResult;
  }

  // Run all dependency checks in parallel
  const [sorobanResult, redisResult, dbResult] = await Promise.all([
    checkSoroban(),
    checkRedis(),
    dbHealthCheck(),
  ]);

  const dependencies: HealthResult['dependencies'] = {
    soroban: { ...sorobanResult, critical: true },
    redis: { ...redisResult, critical: false },
    database: { ...dbResult, critical: false },
  };

  // Determine overall status
  let status: HealthResult['status'] = 'ok';
  for (const [, dep] of Object.entries(dependencies)) {
    if (!dep.ok) {
      if (dep.critical) {
        status = 'unhealthy';
        break;
      } else {
        status = 'degraded';
      }
    }
  }

  const result: HealthResult = {
    status,
    timestamp: now,
    version: config.logging.version,
    dependencies,
  };

  cachedResult = result;
  cacheExpiresAt = now + CACHE_TTL_MS;

  return result;
}

export function invalidateHealthCache(): void {
  cachedResult = null;
  cacheExpiresAt = 0;
}
