import { dbHealthCheck } from './db';
import { config } from '../config';
import { rpcPool } from './rpcPool';
import { getCacheClient } from './cache';

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
    const metrics = rpcPool.getMetrics();
    if (metrics.length > 0) {
      const anyHealthy = metrics.some((p) => p.healthy);
      const healthyProvider = metrics.find((p) => p.healthy);
      if (!anyHealthy) {
        return {
          ok: false,
          latencyMs: Date.now() - start,
          error: 'all rpc providers unhealthy in pool',
        };
      }
      return {
        ok: true,
        latencyMs: healthyProvider?.lastLatencyMs ?? (Date.now() - start),
      };
    }

    const url = config.soroban.rpcUrls[0];
    if (!url) return { ok: false, error: 'no rpc url configured' };

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getNetwork', params: [] }),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        error: `rpc returned HTTP ${res.status}: ${res.statusText}`,
      };
    }
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - start, error: String(err) };
  }
}

async function checkRedis(): Promise<DependencyCheck> {
  if (!config.redis.enabled) return { ok: true, error: undefined };
  const start = Date.now();
  try {
    const client = getCacheClient();
    if (!client) {
      return { ok: false, latencyMs: Date.now() - start, error: 'shared redis client not initialized' };
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
