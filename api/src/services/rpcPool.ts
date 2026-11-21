import { SorobanRpc } from '@stellar/stellar-sdk';
import { config, ConfigError } from '../config';
import { logger } from '../logger';
import { applyKeepAliveAgents } from './httpAgent';
import { getCircuitBreaker } from '../circuit-breaker';

interface ProviderState {
  url: string;
  server: SorobanRpc.Server;
  healthy: boolean;
  consecutiveFailures: number;
  lastFailureAt: number | null;
  lastLatencyMs: number | null;
  totalRequests: number;
  totalFailures: number;
}

export interface RpcExecutionOptions {
  /** Disable retries for calls that may have side effects, such as sendTransaction. */
  failover?: boolean;
}

/** True only for failures that indicate a provider/network problem. */
export function isRetryableRpcError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const candidate = err as {
    code?: unknown;
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown };
    request?: unknown;
    cause?: unknown;
  };

  const status = candidate.response?.status ?? candidate.status ?? candidate.statusCode;
  if (typeof status === 'number') return status === 429 || (status >= 500 && status < 600);
  if (candidate.request && !candidate.response) return true;

  const transportCodes = new Set([
    'ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN',
    'EHOSTUNREACH', 'ECONNREFUSED', 'ERR_NETWORK', 'EPIPE',
  ]);
  if (typeof candidate.code === 'string' && transportCodes.has(candidate.code)) return true;
  return candidate.cause !== err && isRetryableRpcError(candidate.cause);
}

export class RpcPool {
  private providers: ProviderState[];
  private rrIndex = 0;
  private readonly strategy: 'round-robin' | 'latency' | 'random';
  private readonly failureThreshold: number;
  private readonly recoveryIntervalMs: number;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Reuse TCP/TLS connections per RPC endpoint via shared keep-alive agents.
    applyKeepAliveAgents();

    const { rpcUrls, rpc } = config.soroban;
    this.strategy = rpc.selectionStrategy;
    this.failureThreshold = rpc.failureThreshold;
    this.recoveryIntervalMs = rpc.recoveryIntervalMs;
    if (process.env.NODE_ENV === 'production') {
      const insecureUrl = rpcUrls.find((url) => url.startsWith('http://'));
      if (insecureUrl) {
        throw new ConfigError(
          `SOROBAN_RPC_URL(S) must use HTTPS in production; received insecure URL: ${insecureUrl}`,
        );
      }
    }

    this.providers = rpcUrls.map((url) => ({
      url,
      server: new SorobanRpc.Server(url, {
        allowHttp: url.startsWith('http://') && process.env.NODE_ENV !== 'production',
      }),
      healthy: true,
      consecutiveFailures: 0,
      lastFailureAt: null,
      lastLatencyMs: null,
      totalRequests: 0,
      totalFailures: 0,
    }));

    // Run for single-provider pools too, otherwise a provider marked
    // unhealthy is never re-checked and stays flagged forever.
    this.startHealthChecks(rpc.healthCheckIntervalMs);
  }

  private startHealthChecks(intervalMs: number): void {
    this.healthCheckTimer = setInterval(() => this.runHealthChecks(), intervalMs);
    if (this.healthCheckTimer.unref) this.healthCheckTimer.unref();
  }

  private async runHealthChecks(): Promise<void> {
    const now = Date.now();
    for (const p of this.providers) {
      if (p.healthy) continue;
      if (p.lastFailureAt !== null && now - p.lastFailureAt < this.recoveryIntervalMs) continue;

      try {
        const start = Date.now();
        await p.server.getNetwork();
        p.healthy = true;
        p.consecutiveFailures = 0;
        p.lastLatencyMs = Date.now() - start;
        logger.info({ url: p.url }, 'rpc provider recovered');
      } catch {
        p.lastFailureAt = Date.now();
        logger.warn({ url: p.url }, 'rpc provider still unhealthy');
      }
    }
  }

  private healthyProviders(): ProviderState[] {
    return this.providers.filter((p) => p.healthy);
  }

  private selectProvider(): ProviderState {
    const healthy = this.healthyProviders();
    if (healthy.length === 0) {
      logger.warn('all rpc providers unhealthy; using first provider as fallback');
      return this.providers[0];
    }

    switch (this.strategy) {
      case 'latency': {
        const withLatency = healthy.filter((p) => p.lastLatencyMs !== null);
        if (withLatency.length > 0) {
          return withLatency.reduce((best, p) =>
            (p.lastLatencyMs ?? Infinity) < (best.lastLatencyMs ?? Infinity) ? p : best,
          );
        }
        return healthy[0];
      }
      case 'random':
        return healthy[Math.floor(Math.random() * healthy.length)];
      case 'round-robin':
      default:
        this.rrIndex = this.rrIndex % healthy.length;
        const selected = healthy[this.rrIndex];
        this.rrIndex = (this.rrIndex + 1) % healthy.length;
        return selected;
    }
  }

  private markFailure(provider: ProviderState): void {
    provider.consecutiveFailures++;
    provider.totalFailures++;
    provider.lastFailureAt = Date.now();

    if (provider.consecutiveFailures >= this.failureThreshold) {
      if (provider.healthy) {
        provider.healthy = false;
        logger.warn(
          { url: provider.url, consecutiveFailures: provider.consecutiveFailures },
          'rpc provider marked unhealthy',
        );
      }
    }
  }

  /** Runs `fn` against a healthy provider (failing over between them) behind the soroban circuit breaker. */
  async execute<T>(
    fn: (_server: SorobanRpc.Server) => Promise<T>,
    options: RpcExecutionOptions = {},
  ): Promise<T> {
    return getCircuitBreaker('soroban').execute(
      () => this.executeWithFailover(fn, options.failover !== false),
      isRetryableRpcError,
    );
  }

  private async executeWithFailover<T>(
    fn: (_server: SorobanRpc.Server) => Promise<T>,
    allowFailover: boolean,
  ): Promise<T> {
    const tried = new Set<string>();
    const allProviders = [...this.providers];

    let lastError: unknown;
    for (let attempt = 0; attempt < allProviders.length; attempt++) {
      let provider = this.selectProvider();
      if (tried.has(provider.url)) {
        const untried = allProviders.find((p) => !tried.has(p.url));
        if (!untried) break;
        provider = untried;
      }

      tried.add(provider.url);
      provider.totalRequests++;
      const start = Date.now();
      try {
        const result = await fn(provider.server);
        provider.consecutiveFailures = 0;
        provider.lastLatencyMs = Date.now() - start;
        return result;
      } catch (err) {
        lastError = err;
        if (!isRetryableRpcError(err)) {
          logger.debug({ url: provider.url, attempt, err }, 'rpc call failed with a non-retryable error');
          throw err;
        }
        this.markFailure(provider);
        logger.warn({ url: provider.url, attempt }, 'rpc call failed, trying next provider');
        if (!allowFailover) break;
      }
    }

    throw lastError;
  }

  getMetrics(): Array<Omit<ProviderState, 'server'>> {
    return this.providers.map(({ server: _s, ...rest }) => rest);
  }

  destroy(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }
}

export const rpcPool = new RpcPool();
