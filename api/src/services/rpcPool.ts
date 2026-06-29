import { SorobanRpc } from '@stellar/stellar-sdk';
import { config } from '../config';
import { logger } from '../index';

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

export class RpcPool {
  private providers: ProviderState[];
  private rrIndex = 0;
  private readonly strategy: 'round-robin' | 'latency' | 'random';
  private readonly failureThreshold: number;
  private readonly recoveryIntervalMs: number;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    const { rpcUrls, rpc } = config.soroban;
    this.strategy = rpc.selectionStrategy;
    this.failureThreshold = rpc.failureThreshold;
    this.recoveryIntervalMs = rpc.recoveryIntervalMs;

    this.providers = rpcUrls.map((url) => ({
      url,
      server: new SorobanRpc.Server(url),
      healthy: true,
      consecutiveFailures: 0,
      lastFailureAt: null,
      lastLatencyMs: null,
      totalRequests: 0,
      totalFailures: 0,
    }));

    if (this.providers.length > 1) {
      this.startHealthChecks(rpc.healthCheckIntervalMs);
    }
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

  async execute<T>(fn: (_server: SorobanRpc.Server) => Promise<T>): Promise<T> {
    const tried = new Set<string>();
    const allProviders = [...this.providers];

    let lastError: unknown;
    for (let attempt = 0; attempt < allProviders.length; attempt++) {
      const provider = this.selectProvider();
      if (tried.has(provider.url)) {
        const untried = allProviders.find((p) => !tried.has(p.url));
        if (!untried) break;
        tried.add(untried.url);
        provider.totalRequests++;
        const start = Date.now();
        try {
          const result = await fn(untried.server);
          untried.consecutiveFailures = 0;
          untried.lastLatencyMs = Date.now() - start;
          return result;
        } catch (err) {
          lastError = err;
          this.markFailure(untried);
          continue;
        }
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
        this.markFailure(provider);
        logger.warn({ url: provider.url, attempt }, 'rpc call failed, trying next provider');
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
