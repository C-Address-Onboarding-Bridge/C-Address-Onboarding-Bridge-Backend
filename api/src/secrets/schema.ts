export type SecretsProviderName = 'env' | 'local-encrypted' | 'aws' | 'gcp' | 'vault';

export type SecretService = 'api' | 'worker' | 'deploy' | 'shared';

export interface SecretDefinition {
  env: string;
  path: string;
  service: SecretService;
  sensitive: boolean;
  critical?: boolean;
  rotationDays?: number;
  description: string;
}

export const secretSchema: SecretDefinition[] = [
  { env: 'PORT', path: 'runtime/port', service: 'api', sensitive: false, description: 'HTTP listener port' },
  { env: 'HOST', path: 'runtime/host', service: 'api', sensitive: false, description: 'HTTP listener host' },
  { env: 'NODE_ENV', path: 'runtime/node-env', service: 'shared', sensitive: false, description: 'Runtime environment' },
  { env: 'APP_VERSION', path: 'runtime/app-version', service: 'shared', sensitive: false, description: 'Application version for logs and health' },
  { env: 'INSTANCE_ID', path: 'runtime/instance-id', service: 'shared', sensitive: false, description: 'Instance identifier for structured logs' },
  { env: 'SOROBAN_RPC_URL', path: 'soroban/rpc-url', service: 'shared', sensitive: true, critical: true, rotationDays: 90, description: 'Primary Soroban RPC URL' },
  { env: 'SOROBAN_RPC_URLS', path: 'soroban/rpc-urls', service: 'shared', sensitive: true, critical: true, rotationDays: 90, description: 'Comma-delimited Soroban RPC URL pool' },
  { env: 'SOROBAN_NETWORK_PASSPHRASE', path: 'soroban/network-passphrase', service: 'shared', sensitive: false, description: 'Soroban network passphrase' },
  { env: 'BRIDGE_CONTRACT_ID', path: 'soroban/bridge-contract-id', service: 'shared', sensitive: false, description: 'Bridge contract ID' },
  { env: 'BRIDGE_FEE_BPS', path: 'soroban/bridge-fee-bps', service: 'api', sensitive: false, description: 'Bridge fee in basis points' },
  { env: 'RPC_HEALTH_CHECK_INTERVAL_MS', path: 'soroban/rpc-health-check-interval-ms', service: 'api', sensitive: false, description: 'RPC health check interval' },
  { env: 'RPC_FAILURE_THRESHOLD', path: 'soroban/rpc-failure-threshold', service: 'api', sensitive: false, description: 'RPC circuit breaker failure threshold' },
  { env: 'RPC_RECOVERY_INTERVAL_MS', path: 'soroban/rpc-recovery-interval-ms', service: 'api', sensitive: false, description: 'RPC circuit breaker recovery interval' },
  { env: 'RPC_SELECTION_STRATEGY', path: 'soroban/rpc-selection-strategy', service: 'api', sensitive: false, description: 'RPC pool selection strategy' },
  { env: 'MOONPAY_API_KEY', path: 'providers/moonpay/api-key', service: 'api', sensitive: true, critical: true, rotationDays: 90, description: 'MoonPay API key' },
  { env: 'MOONPAY_SECRET_KEY', path: 'providers/moonpay/secret-key', service: 'api', sensitive: true, critical: true, rotationDays: 90, description: 'MoonPay signing secret' },
  { env: 'TRANSAK_API_KEY', path: 'providers/transak/api-key', service: 'api', sensitive: true, critical: true, rotationDays: 90, description: 'Transak API key' },
  { env: 'TRANSAK_ENVIRONMENT', path: 'providers/transak/environment', service: 'api', sensitive: false, description: 'Transak environment' },
  { env: 'TRANSAK_WEBHOOK_SECRET', path: 'providers/transak/webhook-secret', service: 'api', sensitive: true, critical: true, rotationDays: 90, description: 'Transak webhook verification secret' },
  { env: 'API_KEYS', path: 'auth/api-keys', service: 'api', sensitive: true, critical: true, rotationDays: 30, description: 'Bootstrap API keys' },
  { env: 'RBAC_ENABLED', path: 'auth/rbac-enabled', service: 'api', sensitive: false, description: 'RBAC feature flag' },
  { env: 'LOG_LEVEL', path: 'logging/level', service: 'shared', sensitive: false, description: 'Log level' },
  { env: 'LOG_SERVICE_NAME', path: 'logging/service-name', service: 'shared', sensitive: false, description: 'Log service name' },
  { env: 'LOG_SENSITIVE_FIELDS', path: 'logging/sensitive-fields', service: 'shared', sensitive: false, description: 'Fields redacted from logs' },
  { env: 'LOG_BODY_TRUNCATE_LENGTH', path: 'logging/body-truncate-length', service: 'shared', sensitive: false, description: 'Maximum logged body size' },
  { env: 'LOG_AGGREGATION_URL', path: 'logging/aggregation-url', service: 'shared', sensitive: false, description: 'Log aggregation endpoint' },
  { env: 'LOGTAIL_URL', path: 'logging/logtail-url', service: 'shared', sensitive: false, description: 'Logtail endpoint' },
  { env: 'LOGTAIL_TOKEN', path: 'logging/logtail-token', service: 'shared', sensitive: true, critical: true, rotationDays: 90, description: 'Log aggregation token' },
  { env: 'LOG_AGGREGATION_BATCH_SIZE', path: 'logging/aggregation-batch-size', service: 'shared', sensitive: false, description: 'Log aggregation batch size' },
  { env: 'LOG_AGGREGATION_FLUSH_MS', path: 'logging/aggregation-flush-ms', service: 'shared', sensitive: false, description: 'Log aggregation flush interval' },
  { env: 'REDIS_RATE_LIMIT', path: 'redis/rate-limit-enabled', service: 'api', sensitive: false, description: 'Redis rate limiting flag' },
  { env: 'RATE_LIMIT_WINDOW_MS', path: 'rate-limit/window-ms', service: 'api', sensitive: false, description: 'Rate limit window' },
  { env: 'RATE_LIMIT_BURST_FACTOR', path: 'rate-limit/burst-factor', service: 'api', sensitive: false, description: 'Rate limit burst multiplier' },
  { env: 'COMPRESSION_THRESHOLD_BYTES', path: 'compression/threshold-bytes', service: 'api', sensitive: false, description: 'Compression threshold' },
  { env: 'COMPRESSION_LEVEL', path: 'compression/level', service: 'api', sensitive: false, description: 'Compression level' },
  { env: 'GRACEFUL_SHUTDOWN_TIMEOUT_MS', path: 'runtime/graceful-shutdown-timeout-ms', service: 'api', sensitive: false, description: 'Graceful shutdown timeout' },
  { env: 'REDIS_URL', path: 'redis/url', service: 'shared', sensitive: true, critical: true, rotationDays: 90, description: 'Redis connection URL' },
  { env: 'REDIS_STATUS_TTL_SECONDS', path: 'redis/status-ttl-seconds', service: 'api', sensitive: false, description: 'Status cache TTL' },
  { env: 'REDIS_QUOTE_TTL_SECONDS', path: 'redis/quote-ttl-seconds', service: 'api', sensitive: false, description: 'Quote cache TTL' },
  { env: 'DATABASE_URL', path: 'database/url', service: 'api', sensitive: true, critical: true, rotationDays: 90, description: 'Postgres connection URL' },
  { env: 'DB_POOL_MAX', path: 'database/pool-max', service: 'api', sensitive: false, description: 'Postgres pool maximum' },
  { env: 'DB_IDLE_TIMEOUT_MS', path: 'database/idle-timeout-ms', service: 'api', sensitive: false, description: 'Postgres idle timeout' },
  { env: 'DB_CONNECTION_TIMEOUT_MS', path: 'database/connection-timeout-ms', service: 'api', sensitive: false, description: 'Postgres connection timeout' },
  { env: 'DB_SSL', path: 'database/ssl', service: 'api', sensitive: false, description: 'Postgres SSL flag' },
  { env: 'WS_AUTH_REQUIRED', path: 'websocket/auth-required', service: 'api', sensitive: false, description: 'WebSocket auth flag' },
  { env: 'WS_MAX_SUBSCRIPTIONS', path: 'websocket/max-subscriptions', service: 'api', sensitive: false, description: 'WebSocket subscription limit' },
  { env: 'JOBS_ENABLED', path: 'jobs/enabled', service: 'worker', sensitive: false, description: 'Background jobs flag' },
  { env: 'JOB_TX_POLL_INTERVAL_MS', path: 'jobs/tx-poll-interval-ms', service: 'worker', sensitive: false, description: 'Transaction polling job interval' },
  { env: 'JOB_METRICS_INTERVAL_MS', path: 'jobs/metrics-interval-ms', service: 'worker', sensitive: false, description: 'Metrics job interval' },
  { env: 'JOB_CLEANUP_INTERVAL_MS', path: 'jobs/cleanup-interval-ms', service: 'worker', sensitive: false, description: 'Cleanup job interval' },
  { env: 'JOB_CONCURRENCY_TX_STATUS', path: 'jobs/concurrency-tx-status', service: 'worker', sensitive: false, description: 'Transaction status job concurrency' },
  { env: 'JOB_CONCURRENCY_WEBHOOK_RETRY', path: 'jobs/concurrency-webhook-retry', service: 'worker', sensitive: false, description: 'Webhook retry job concurrency' },
  { env: 'JOB_CONCURRENCY_CACHE_WARMUP', path: 'jobs/concurrency-cache-warmup', service: 'worker', sensitive: false, description: 'Cache warmup job concurrency' },
  { env: 'JOB_CONCURRENCY_METRICS', path: 'jobs/concurrency-metrics', service: 'worker', sensitive: false, description: 'Metrics job concurrency' },
  { env: 'JOB_CONCURRENCY_CLEANUP', path: 'jobs/concurrency-cleanup', service: 'worker', sensitive: false, description: 'Cleanup job concurrency' },
  { env: 'STELLAR_EXPLORER', path: 'integrations/stellar-explorer', service: 'shared', sensitive: false, description: 'Explorer provider name' },
  { env: 'CEX_API_ENDPOINT', path: 'providers/cex/api-endpoint', service: 'api', sensitive: false, description: 'CEX API endpoint override' },
  { env: 'WEBHOOK_SIGNING_SECRET', path: 'webhooks/signing-secret', service: 'api', sensitive: true, critical: true, rotationDays: 30, description: 'Outbound webhook signing secret' },
];

export function definitionsForService(service: string): SecretDefinition[] {
  return secretSchema.filter((definition) => definition.service === 'shared' || definition.service === service);
}
