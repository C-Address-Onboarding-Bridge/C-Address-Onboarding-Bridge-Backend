import { Registry, collectDefaultMetrics, Counter, Histogram, Gauge } from 'prom-client';

export const register = new Registry();

collectDefaultMetrics({ register });

export const httpRequestCounter = new Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'path', 'status'],
  registers: [register],
});

export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'path', 'status'],
  buckets: [0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
  registers: [register],
});

export const httpResponseSize = new Histogram({
  name: 'http_response_size_bytes',
  help: 'HTTP response size in bytes',
  labelNames: ['method', 'path'],
  buckets: [100, 500, 1000, 5000, 10000, 50000, 100000],
  registers: [register],
});

export const activeRequestsGauge = new Gauge({
  name: 'http_active_requests',
  help: 'Number of active HTTP requests',
  registers: [register],
});

export const externalCallDuration = new Histogram({
  name: 'external_api_call_duration_seconds',
  help: 'External API call duration in seconds',
  labelNames: ['service'],
  buckets: [0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
  registers: [register],
});

export const cacheHitCounter = new Counter({
  name: 'cache_hits_total',
  help: 'Cache hit count',
  registers: [register],
});

export const cacheMissCounter = new Counter({
  name: 'cache_misses_total',
  help: 'Cache miss count',
  registers: [register],
});

export const circuitBreakerState = new Gauge({
  name: 'circuit_breaker_state',
  help: 'Circuit breaker state (0=closed, 1=open, 2=half-open)',
  labelNames: ['service'],
  registers: [register],
});

export const fundingCount = new Counter({
  name: 'funding_operations_total',
  help: 'Total funding operations',
  labelNames: ['status'],
  registers: [register],
});

export const fundingVolume = new Counter({
  name: 'funding_volume_total',
  help: 'Total funding volume in base units',
  registers: [register],
});

export const feeCollected = new Counter({
  name: 'fee_collected_total',
  help: 'Total fees collected in base units',
  registers: [register],
});

export const activeUsersGauge = new Gauge({
  name: 'active_users',
  help: 'Number of active users (unique API keys in the last hour)',
  registers: [register],
});

const CB_STATE_MAP: Record<string, number> = { closed: 0, open: 1, 'half-open': 2 };

export function updateCircuitBreakerMetrics(circuits: Map<string, { getState(): string }>): void {
  for (const [name, cb] of circuits) {
    const state = cb.getState().toLowerCase();
    circuitBreakerState.set({ service: name }, CB_STATE_MAP[state] ?? 0);
  }
}
