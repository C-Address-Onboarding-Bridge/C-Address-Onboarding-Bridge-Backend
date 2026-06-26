import {
  BridgeEventType,
  BridgeEvent,
  BridgeEventDataMap,
  EventHandler,
  EventEmitterOptions,
  TransactionStatus,
} from './types';

type StatusFetcher = (txHash: string) => Promise<TransactionStatus>;
type HealthChecker = () => Promise<boolean>;

export class BridgeEventEmitter {
  private readonly handlers = new Map<BridgeEventType, Set<EventHandler<BridgeEventType>>>();
  private readonly history: BridgeEvent[] = [];
  private readonly historySize: number;
  private readonly pollIntervalMs: number;
  private readonly healthCheckIntervalMs: number;
  private readonly watchTimers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly statusCache = new Map<string, string>();
  private healthTimer?: ReturnType<typeof setInterval>;
  private reconnectAttempt = 0;
  private online = true;
  private destroyed = false;

  constructor(
    private readonly statusFetcher: StatusFetcher,
    private readonly healthChecker?: HealthChecker,
    options?: EventEmitterOptions,
  ) {
    this.pollIntervalMs = options?.pollIntervalMs ?? 2_000;
    this.historySize = options?.historySize ?? 100;
    this.healthCheckIntervalMs = options?.healthCheckIntervalMs ?? 10_000;

    if (this.healthChecker) {
      this.startHealthCheck();
    }
  }

  on<K extends BridgeEventType>(event: K, handler: EventHandler<K>): this {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler as EventHandler<BridgeEventType>);

    // Replay buffered history for late subscribers
    for (const entry of this.history) {
      if (entry.type === event) {
        try {
          handler(entry as BridgeEvent<K>);
        } catch {}
      }
    }

    return this;
  }

  off<K extends BridgeEventType>(event: K, handler: EventHandler<K>): this {
    this.handlers.get(event)?.delete(handler as EventHandler<BridgeEventType>);
    return this;
  }

  /** Begin polling a transaction hash for status changes. */
  watch(txHash: string): this {
    if (this.destroyed || this.watchTimers.has(txHash)) return this;

    const timer = setInterval(async () => {
      try {
        const status = await this.statusFetcher(txHash);
        const previous = this.statusCache.get(txHash);

        if (previous !== status.status) {
          if (previous !== undefined) {
            this.emit('transaction:status:changed', { txHash, status, previousStatus: previous });
          }
          this.statusCache.set(txHash, status.status);

          if (status.status === 'pending') {
            this.emit('transaction:pending', { txHash, status });
          } else if (status.status === 'success') {
            this.emit('transaction:success', { txHash, status });
            this.unwatch(txHash);
          } else if (status.status === 'failed') {
            this.emit('transaction:failed', { txHash, status, error: status.error });
            this.unwatch(txHash);
          }
        }
      } catch (err) {
        this.emit('error', { message: 'Failed to poll transaction status', error: err });
      }
    }, this.pollIntervalMs);

    this.watchTimers.set(txHash, timer);
    return this;
  }

  /** Stop polling a specific transaction hash. */
  unwatch(txHash: string): this {
    const timer = this.watchTimers.get(txHash);
    if (timer !== undefined) {
      clearInterval(timer);
      this.watchTimers.delete(txHash);
      this.statusCache.delete(txHash);
    }
    return this;
  }

  /** Stop all polling and clear all listeners and history. */
  destroy(): void {
    this.destroyed = true;
    for (const timer of this.watchTimers.values()) clearInterval(timer);
    this.watchTimers.clear();
    this.statusCache.clear();
    if (this.healthTimer !== undefined) clearInterval(this.healthTimer);
    this.handlers.clear();
    this.history.length = 0;
  }

  private startHealthCheck(): void {
    this.healthTimer = setInterval(async () => {
      if (this.destroyed) return;
      try {
        const nowOnline = await this.healthChecker!();

        if (!this.online && nowOnline) {
          this.online = true;
          this.reconnectAttempt = 0;
          this.emit('online', { at: new Date().toISOString() });
        } else if (this.online && !nowOnline) {
          this.online = false;
          this.reconnectAttempt = 0;
          this.emit('offline', { at: new Date().toISOString() });
        } else if (!this.online && !nowOnline) {
          this.reconnectAttempt++;
          this.emit('reconnecting', { attempt: this.reconnectAttempt, at: new Date().toISOString() });
        }
      } catch {
        if (this.online) {
          this.online = false;
          this.emit('offline', { at: new Date().toISOString() });
        }
      }
    }, this.healthCheckIntervalMs);
  }

  private emit<K extends BridgeEventType>(
    type: K,
    data: K extends keyof BridgeEventDataMap ? BridgeEventDataMap[K] : never,
  ): void {
    const event = { type, data, timestamp: new Date().toISOString() } as unknown as BridgeEvent;

    this.history.push(event);
    if (this.history.length > this.historySize) this.history.shift();

    const handlers = this.handlers.get(type);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(event);
        } catch {}
      }
    }
  }
}
