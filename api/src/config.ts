import { initializeSecrets } from './secrets/manager';

initializeSecrets();

/** Thrown at startup when a required environment variable is missing. */
export class ConfigError extends Error {
  constructor(key: string) {
    super(`missing required config: ${key}`);
    this.name = 'ConfigError';
  }
}

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new ConfigError(key);
  return val;
}

/**
 * Parse the TRUST_PROXY environment variable into a value suitable for
 * `app.set('trust proxy', ...)`.
 *
 * Accepts:
 *  - a hop count, e.g. `1` or `2`
 *  - a comma-separated list of IPs/CIDRs, e.g. `10.0.0.0/8,192.168.1.1`
 *  - a boolean-ish string (`true`/`false`)
 *
 * Defaults to `false` (trust proxy disabled) so that deployments without a
 * load balancer keep using the socket address as `req.ip`.
 */
export function parseTrustProxy(raw: string | undefined): boolean | number | string[] {
  const value = (raw || '').trim();
  if (!value) return false;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^\d+$/.test(value)) return parseInt(value, 10);
  const list = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return list.length > 0 ? list : false;
}

/** Centralised runtime configuration derived from environment variables. */
export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  host: process.env.HOST || '0.0.0.0',
  /**
   * Express `trust proxy` setting. Controls how `req.ip` is derived when the
   * API sits behind a load balancer / reverse proxy. Without this, IP
   * allowlists, IP rate limits and IP bans all key off the proxy address.
   */
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  soroban: {
    rpcUrls: (process.env.SOROBAN_RPC_URLS || process.env.SOROBAN_RPC_URL || 'https://soroban-rpc.testnet.stellar.org')
      .split(',')
      .map((u) => u.trim())
      .filter(Boolean),
    networkPassphrase: process.env.SOROBAN_NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015',
    bridgeContractId: process.env.BRIDGE_CONTRACT_ID || '',
    feeBps: parseInt(process.env.BRIDGE_FEE_BPS || '30', 10),
    rpc: {
      healthCheckIntervalMs: parseInt(process.env.RPC_HEALTH_CHECK_INTERVAL_MS || '30000', 10),
      failureThreshold: parseInt(process.env.RPC_FAILURE_THRESHOLD || '3', 10),
      recoveryIntervalMs: parseInt(process.env.RPC_RECOVERY_INTERVAL_MS || '60000', 10),
      selectionStrategy: (process.env.RPC_SELECTION_STRATEGY || 'round-robin') as 'round-robin' | 'latency' | 'random',
    },
  },
  moonpay: {
    apiKey: process.env.MOONPAY_API_KEY || '',
    secretKey: process.env.MOONPAY_SECRET_KEY || '',
  },
  transak: {
    apiKey: process.env.TRANSAK_API_KEY || '',
    environment: process.env.TRANSAK_ENVIRONMENT || 'STAGING',
    webhookSecret: process.env.TRANSAK_WEBHOOK_SECRET || '',
  },
  /** Exchange API credentials for CEX withdrawal routing. Unauthenticated when empty. */
  cex: {
    binance: {
      apiKey: process.env.BINANCE_API_KEY || '',
      apiSecret: process.env.BINANCE_API_SECRET || '',
    },
    coinbase: {
      apiKey: process.env.COINBASE_API_KEY || '',
      apiSecret: process.env.COINBASE_API_SECRET || '',
      passphrase: process.env.COINBASE_API_PASSPHRASE || '',
    },
    kraken: {
      apiKey: process.env.KRAKEN_API_KEY || '',
      apiSecret: process.env.KRAKEN_API_SECRET || '',
    },
  },
  /** Comma-separated list of accepted `X-API-Key` values. Auth is disabled when empty. */
  apiKeys: (process.env.API_KEYS || '').split(',').filter(Boolean),
  /** Comma-separated list of allowed CORS origins. All origins are allowed when empty. */
  corsOrigins: (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  logLevel: process.env.LOG_LEVEL || 'info',
  logging: {
    serviceName: process.env.LOG_SERVICE_NAME || 'bridge-api',
    version: process.env.APP_VERSION || '0.1.0',
    environment: process.env.NODE_ENV || 'development',
    sensitiveFields: (process.env.LOG_SENSITIVE_FIELDS || 'apiKey,api_key,secret,secretKey,password,token,walletAddress,email,privateKey,mnemonic,authorization,x-api-key').split(','),
    bodyTruncateLength: parseInt(process.env.LOG_BODY_TRUNCATE_LENGTH || '200', 10),
  },
  rateLimit: {
    redisEnabled: process.env.REDIS_RATE_LIMIT === 'true' || (process.env.REDIS_URL !== undefined && process.env.REDIS_URL !== ''),
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
    burstFactor: parseInt(process.env.RATE_LIMIT_BURST_FACTOR || '2', 10),
  },
  observability: {
    otelEnabled: process.env.OTEL_ENABLED !== 'false',
    otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318/v1/traces',
    traceSampleRatio: parseFloat(process.env.OTEL_TRACE_SAMPLE_RATIO || '0.1'),
    lokiPushUrl: process.env.LOKI_PUSH_URL || '',
    adminAlertUrl: process.env.ADMIN_ALERT_URL || '',
  },
  compression: {
    threshold: parseInt(process.env.COMPRESSION_THRESHOLD_BYTES || '1024', 10),
    level: parseInt(process.env.COMPRESSION_LEVEL || '6', 10),
  },
  rbac: {
    enabled: process.env.RBAC_ENABLED !== 'false',
  },
  // src/middleware/idempotency.ts reads config.idempotency.required, but the
  // section was never added here. The variable and its `false` default are
  // already documented in .env.example, .env.local.example and
  // docs/developer-setup.md, so this restores the documented behaviour.
  idempotency: {
    required: process.env.IDEMPOTENCY_KEY_REQUIRED === 'true',
  },
  shutdown: {
    timeoutMs: parseInt(process.env.GRACEFUL_SHUTDOWN_TIMEOUT_MS || '30000', 10),
  },
  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
    enabled: process.env.REDIS_URL !== undefined && process.env.REDIS_URL !== '',
    /** Status responses – invalidated by webhook on state change. */
    statusTtlSeconds: parseInt(process.env.REDIS_STATUS_TTL_SECONDS || '10', 10),
    /** Quote responses – invalidated on new ledger / block. */
    quoteTtlSeconds: parseInt(process.env.REDIS_QUOTE_TTL_SECONDS || '30', 10),
    /** CEX route responses – exchange rates change slowly. */
    cexTtlSeconds: parseInt(process.env.REDIS_CEX_TTL_SECONDS || '60', 10),
    /** Transaction-list responses – short TTL, invalidated on new transaction. */
    transactionsTtlSeconds: parseInt(process.env.REDIS_TRANSACTIONS_TTL_SECONDS || '5', 10),
  },
  database: {
    url: process.env.DATABASE_URL || '',
    poolMin: parseInt(process.env.DB_POOL_MIN || '2', 10),
    poolMax: parseInt(process.env.DB_POOL_MAX || '20', 10),
    idleTimeoutMs: parseInt(process.env.DB_IDLE_TIMEOUT_MS || '10000', 10),
    connectionTimeoutMs: parseInt(process.env.DB_CONNECTION_TIMEOUT_MS || '5000', 10),
    statementTimeoutMs: parseInt(process.env.DB_STATEMENT_TIMEOUT_MS || '30000', 10),
    ssl: process.env.DB_SSL === 'true',
  },
  /** Keep-alive connection pooling for outbound HTTP (Soroban RPC). */
  httpAgent: {
    maxSockets: parseInt(process.env.HTTP_AGENT_MAX_SOCKETS || '50', 10),
    maxFreeSockets: parseInt(process.env.HTTP_AGENT_MAX_FREE_SOCKETS || '10', 10),
    keepAliveMsecs: parseInt(process.env.HTTP_AGENT_KEEP_ALIVE_MS || '15000', 10),
  },
  websocket: {
    authRequired: process.env.WS_AUTH_REQUIRED !== 'false',
    maxSubscriptionsPerConnection: parseInt(process.env.WS_MAX_SUBSCRIPTIONS || '10', 10),
  },
  jobs: {
    enabled: process.env.JOBS_ENABLED !== 'false' && (process.env.REDIS_URL !== undefined && process.env.REDIS_URL !== ''),
    txPollIntervalMs: parseInt(process.env.JOB_TX_POLL_INTERVAL_MS || '60000', 10),
    metricsIntervalMs: parseInt(process.env.JOB_METRICS_INTERVAL_MS || '3600000', 10),
    cleanupIntervalMs: parseInt(process.env.JOB_CLEANUP_INTERVAL_MS || '86400000', 10),
    concurrency: {
      txStatus: parseInt(process.env.JOB_CONCURRENCY_TX_STATUS || '5', 10),
      webhookRetry: parseInt(process.env.JOB_CONCURRENCY_WEBHOOK_RETRY || '3', 10),
      cacheWarmup: parseInt(process.env.JOB_CONCURRENCY_CACHE_WARMUP || '2', 10),
      metrics: parseInt(process.env.JOB_CONCURRENCY_METRICS || '1', 10),
      cleanup: parseInt(process.env.JOB_CONCURRENCY_CLEANUP || '1', 10),
      asyncAudit: parseInt(process.env.JOB_CONCURRENCY_ASYNC_AUDIT || '2', 10),
      asyncPipeline: parseInt(process.env.JOB_CONCURRENCY_ASYNC_PIPELINE || '5', 10),
    },
  },
  asyncPipeline: {
    /**
     * Master switch. When false every call falls through to the synchronous
     * path so the pipeline is completely transparent to callers.
     * Defaults to enabled whenever a REDIS_URL is configured.
     */
    enabled: process.env.ASYNC_PIPELINE_ENABLED !== 'false'
      && (process.env.REDIS_URL !== undefined && process.env.REDIS_URL !== ''),
    /**
     * Number of waiting jobs in the best-effort queue above which the pipeline
     * is considered backpressured. Non-critical ops are dropped while over
     * this threshold.
     */
    backpressureThreshold: parseInt(process.env.ASYNC_BACKPRESSURE_THRESHOLD || '1000', 10),
    /**
     * How long (ms) the in-process analytics buffer accumulate

/* … truncated 162 chars — edit only what you need near the top … */
