import { dbHealthCheck } from './db';
import { getCacheClient } from './cache';
import { rpcPool } from './rpcPool';
import { config } from '../config';

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
  const metrics = rpcPool.getMetrics();
  if (metrics.length === 0) {
    return { ok: false, latencyMs: Date.now() - start, error: 'no rpc url configured' };
  }
  // #702: report the pool's own view of provider health instead of probing a
  // single URL. The pool tracks per-provider success/failure and recovery, so a
  // 4xx from one provider is not a "healthy" RPC; the node is healthy when at
  // least one provider is healthy.
  const healthy = metrics.filter((m) => m.healthy);
  return {
    ok: healthy.length > 0,
    latencyMs: Date.now() - start,
    error: healthy.length > 0 ? undefined : 'all rpc providers unhealthy',
  };
}

async function checkRedis(): Promise<DependencyCheck> {
  if (!config.redis.enabled) return { ok: true, error: undefined };
  const start = Date.now();
  try {
    // #702: ping the client the app already uses instead of opening a fresh
    // connection (connect/ping/quit) on every uncached health probe.
    const client = getCacheClient();
    if (!client) {
      return { ok: false, latencyMs: Date.now() - start, error: 'redis client unavailable' };
    }
    await client.ping();
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

  const [dbCheck, sorobanCheck, redisCheck] = await Promise.all([dbHealthCheck(), checkSoroban(), checkRedis()]);

  const dependencies: HealthResult['dependencies'] = {
    database: { ...dbCheck, critical: true },
    soroban: { ...sorobanCheck, critical: true },
    redis: { ...redisCheck, critical: false },
  };

  const checks = Object.values(dependencies);
  const criticalFailing = checks.some((d) => d.critical && !d.ok);
  const anyFailing = checks.some((d) => !d.ok);
  const status: HealthResult['status'] = criticalFailing ? 'unhealthy' : anyFailing ? 'degraded' : 'ok';

  cachedResult = {
    status,
    timestamp: now,
    version: config.logging.version,
    dependencies,
  };
  cacheExpiresAt = now + CACHE_TTL_MS;

  return cachedResult;
}

export function invalidateHealthCache(): void {
  cachedResult = null;
  cacheExpiresAt = 0;
}
