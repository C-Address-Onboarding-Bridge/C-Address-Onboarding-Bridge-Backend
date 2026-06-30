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

/** Rolling hit-ratio gauge updated on every cache access. */
export const cacheHitRatioGauge = new Gauge({
  name: 'cache_hit_ratio',
  help: 'Cache hit ratio (0.0 – 1.0)',
  registers: [register],
});

/** Number of keys currently in Redis (sampled periodically via DBSIZE). */
export const cacheEntryCountGauge = new Gauge({
  name: 'cache_entry_count',
  help: 'Number of keys currently stored in Redis (DBSIZE)',
  registers: [register],
});

/** Memory used by Redis in bytes (sampled periodically via INFO memory). */
export const cacheMemoryBytesGauge = new Gauge({
  name: 'cache_memory_bytes',
  help: 'Bytes of memory used by Redis (used_memory from INFO)',
  registers: [register],
});

export const circuitBreakerState = new Gauge({
  name: 'circuit_breaker_state',
  help: 'Circuit breaker state (0=closed, 1=open, 2=half-open)',
  labelNames: ['service'],
  registers: [register],
});

// --- Business KPI metrics ---

export const fundingCount = new Counter({
  name: 'funding_operations_total',
  help: 'Total funding operations',
  labelNames: ['source', 'status'],
  registers: [register],
});

export const fundingVolume = new Counter({
  name: 'funding_volume_xlm_total',
  help: 'Total XLM funded in stroops',
  labelNames: ['source', 'currency'],
  registers: [register],
});

export const feeCollected = new Counter({
  name: 'fee_collected_total',
  help: 'Total fees collected in stroops',
  labelNames: ['source', 'currency'],
  registers: [register],
});

export const uniqueFundersGauge = new Gauge({
  name: 'unique_funders_24h',
  help: 'Unique funders (API keys) in the last 24 hours',
  registers: [register],
});

export const fundingAmountHistogram = new Histogram({
  name: 'funding_amount_stroops',
  help: 'Distribution of funding amounts in stroops',
  labelNames: ['source'],
  buckets: [1e7, 5e7, 1e8, 5e8, 1e9, 5e9, 1e10],
  registers: [register],
});

export const feeRateGauge = new Gauge({
  name: 'fee_rate_bps',
  help: 'Current bridge fee rate in basis points',
  registers: [register],
});

export const exchangeRoutingCount = new Counter({
  name: 'exchange_routing_total',
  help: 'CEX withdrawal routing count per exchange',
  labelNames: ['exchange', 'status'],
  registers: [register],
});

export const onrampRequestCount = new Counter({
  name: 'onramp_requests_total',
  help: 'On-ramp widget URL generation count',
  labelNames: ['provider', 'status'],
  registers: [register],
});

export const transactionStatusCount = new Counter({
  name: 'transaction_status_total',
  help: 'Transaction status transitions',
  labelNames: ['status', 'source'],
  registers: [register],
});

const funderTimestamps = new Map<string, number>();
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

export function recordUniqueFunder(funderId: string): void {
  const now = Date.now();
  funderTimestamps.set(funderId, now);

  const cutoff = now - TWENTY_FOUR_HOURS_MS;
  for (const [id, ts] of funderTimestamps) {
    if (ts < cutoff) funderTimestamps.delete(id);
  }
  uniqueFundersGauge.set(funderTimestamps.size);
}

export interface FundingMetricInput {
  source: 'api' | 'sdk' | 'cex' | 'onramp';
  status: 'success' | 'pending' | 'failed';
  amountStroops?: string;
  feeStroops?: string;
  currency?: string;
  funderId?: string;
}

export function recordFundingMetrics(input: FundingMetricInput): void {
  const currency = input.currency ?? 'XLM';
  fundingCount.inc({ source: input.source, status: input.status });
  transactionStatusCount.inc({ status: input.status, source: input.source });

  if (input.amountStroops) {
    const amount = parseInt(input.amountStroops, 10);
    if (!Number.isNaN(amount) && amount > 0) {
      fundingVolume.inc({ source: input.source, currency }, amount);
      fundingAmountHistogram.observe({ source: input.source }, amount);
    }
  }

  if (input.feeStroops) {
    const fee = parseInt(input.feeStroops, 10);
    if (!Number.isNaN(fee) && fee > 0) {
      feeCollected.inc({ source: input.source, currency }, fee);
    }
  }

  if (input.funderId) {
    recordUniqueFunder(input.funderId);
  }
}

export function setFeeRateBps(bps: number): void {
  feeRateGauge.set(bps);
}

const CB_STATE_MAP: Record<string, number> = { closed: 0, open: 1, 'half-open': 2 };

export function updateCircuitBreakerMetrics(circuits: Map<string, { getState(): string }>): void {
  for (const [name, cb] of circuits) {
    const state = cb.getState().toLowerCase();
    circuitBreakerState.set({ service: name }, CB_STATE_MAP[state] ?? 0);
  }
}
