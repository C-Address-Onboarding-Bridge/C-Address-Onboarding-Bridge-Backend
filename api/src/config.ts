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

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  host: process.env.HOST || '0.0.0.0',
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
  apiKeys: (process.env.API_KEYS || '').split(',').filter(Boolean),
  logLevel: process.env.LOG_LEVEL || 'info',
  logging: {
    serviceName: process.env.LOG_SERVICE_NAME || 'bridge-api',
    version: process.env.APP_VERSION || '0.1.0',
    environment: process.env.NODE_ENV || 'development',
  },
  rateLimit: {
    redisEnabled: process.env.REDIS_RATE_LIMIT === 'true',
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
    burstFactor: parseInt(process.env.RATE_LIMIT_BURST_FACTOR || '2', 10),
  },
  compression: {
    threshold: parseInt(process.env.COMPRESSION_THRESHOLD_BYTES || '1024', 10),
    level: parseInt(process.env.COMPRESSION_LEVEL || '6', 10),
  },
  rbac: {
    enabled: process.env.RBAC_ENABLED !== 'false',
  },
  shutdown: {
    timeoutMs: parseInt(process.env.GRACEFUL_SHUTDOWN_TIMEOUT_MS || '30000', 10),
  },
  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
    enabled: process.env.REDIS_URL !== undefined && process.env.REDIS_URL !== '',
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
    },
  },
  logging: {
    sensitiveFields: (process.env.LOG_SENSITIVE_FIELDS || 'apiKey,api_key,secret,secretKey,password,token,walletAddress,email,privateKey,mnemonic,authorization,x-api-key').split(','),
    bodyTruncateLength: parseInt(process.env.LOG_BODY_TRUNCATE_LENGTH || '200', 10),
  },
};
