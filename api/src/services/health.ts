import { config } from '../config';
import { dbHealthCheck } from './db';
import { getRedisClient } from './redis';
import { rpcPool } from './rpcPool';
import { logger } from '../utils/logger';

export interface DependencyHealth {
  ok: boolean;
  critical: boolean;
  latencyMs?: number;
  error?: string;
  details?: Record<string, unknown>;
}

export interface HealthStatus {
  status: 'ok' | 'degraded' | 'unhealthy';
  timestamp: string;
  version: string;
  uptimeSeconds: number;
  dependencies: Record<string, DependencyHealth>;
}

const CACHE_TTL_MS = 5000;

let cached: HealthStatus | null = null;
let cachedAt = 0;

export function invalidateHealthCache(): void {
  cached = null;
  cachedAt = 0;
}

async function checkDatabase(): Promise<DependencyHealth> {
  const start = Date.now();
  try {
    const result = await dbHealthCheck();
    return {
      ok: result.ok,
      critical: false,
      latencyMs: Date.now() - start,
      error: result.ok ? undefined : result.error,
    };
  } catch (err) {
    return {
      ok: false,
      critical: false,
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function checkRedis(): Promise<DependencyHealth> {
  const start = Date.now();
  try {
    const client = getRedisClient();
    if (!client) {
      return { ok: true, critical: false, details: { enabled: false } };
    }
    const pong = await client.ping();
    return {
      ok: pong === 'PONG',
      critical: false,
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    return {
      ok: false,
      critical: false,
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function checkSoroban(): Promise<DependencyHealth> {
  const start = Date.now();
  try {
    const metrics = rpcPool.getMetrics();
    const healthyProviders = metrics.filter((m) => m.healthy);
    const ok = healthyProviders.length > 0;
    return {
      ok,
      critical: true,
      latencyMs: Date.now() - start,
      details: {
        totalProviders: metrics.length,
        healthyProviders: healthyProviders.length,
      },
      error: ok ? undefined : 'No healthy RPC providers',
    };
  } catch (err) {
    return {
      ok: false,
      critical: true,
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function getHealthStatus(force = false): Promise<HealthStatus> {
  const now = Date.now();
  if (!force && cached && now - cachedAt < CACHE_TTL_MS) {
    return cached;
  }

  const [database, redis, soroban] = await Promise.all([
    checkDatabase(),
    checkRedis(),
    checkSoroban(),
  ]);

  const dependencies: Record<string, DependencyHealth> = {
    database,
    redis,
    soroban,
  };

  const criticalDown = Object.values(dependencies).some(
    (d) => d.critical && !d.ok,
  );
  const anyDown = Object.values(dependencies).some((d) => !d.ok);

  const status: HealthStatus['status'] = criticalDown
    ? 'unhealthy'
    : anyDown
      ? 'degraded'
      : 'ok';

  const result: HealthStatus = {
    status,
    timestamp: new Date().toISOString(),
    version: config.logging.version,
    uptimeSeconds: Math.floor(process.uptime()),
    dependencies,
  };

  cached = result;
  cachedAt = now;

  if (status !== 'ok') {
    logger.warn('Health check degraded', { status, dependencies });
  }

  return result;
}
