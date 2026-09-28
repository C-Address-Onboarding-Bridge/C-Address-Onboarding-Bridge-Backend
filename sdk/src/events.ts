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

interface WatchState {
  timer?: ReturnType<typeof setTimeout>;
  cancelled: boolean;
}

export class BridgeEventEmitter {
  private readonly handlers = new Map<BridgeEventType, Set<EventHandler<BridgeEventType>>>();
  private readonly history: BridgeEvent[] = [];
  private readonly historySize: number;
  private readonly pollIntervalMs: number;
  private readonly healthCheckIntervalMs: number;
  private readonly watchTimers = new Map<string, WatchState>();
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

    const state: WatchState = { cancelled: false };
    this.watchTimers.set(txHash, state);

    const scheduleNext = (): void => {
      if (state.cancelled || this.destroyed) return;
      state.timer = setTimeout(() => {
        void tick();
      }, this.pollIntervalMs);
    };

    const tick = async (): Promise<void> => {
      // Bail before doing any work if the watch was cancelled while we were
      // scheduled but not yet running.
      if (state.cancelled || this.destroyed) return;

      let status: TransactionStatus;
      try {
        status = await this.statusFetcher(txHash);
      } catch (err) {
        // The watch may have been cancelled or the emitter destroyed while the
        // fetch was in flight. In that case, swallow the error and stop.
        if (state.cancelled || this.destroyed) return;
        this.emit('error', { message: 'Failed to poll transaction status', error: err });
        scheduleNext();
        return;
      }

      // Re-check cancellation after the await. This is what prevents
      // `transaction:success` from firing after `unwatch`/`destroy`.
      if (state.cancelled || this.destroyed) return;

      const previous = this.statusCache.get(txHash);

      if (previous !== status.status) {
        if (previous !== undefined) {
          this.emit('transaction:status:changed', {
            txHash,
            status,
            previousStatus: previous,
          });
        }
        this.statusCache.set(txHash, status.status);

        if (status.status === 'pending') {
          this.emit('transaction:pending', { txHash, status });
        } else if (status.status === 'success') {
          this.emit('transaction:success', { txHash, status });
          this.unwatch(txHash);
          return;
        } else if (status.status === 'failed') {
          this.emit('transaction:failed', { txHash, status, error: status.error });
          this.unwatch(txHash);
          return;
        }
      }

      // Only schedule the next poll after the current one has fully settled.
      scheduleNext();
    };

    scheduleNext();
    return this;
  }

  /** Stop polling a specific transaction hash. */
  unwatch(txHash: string): this {
    const state = this.watchTimers.get(txHash);
    if (state !== undefined) {
      state.cancelled = true;
      if (state.timer !== undefined) clearTimeout(state.timer);
      this.watchTimers.delete(txHash);
      this.statusCache.delete(txHash);
    }
    return this;
  }

  /** Stop all polling and clear all listeners and history. */
  destroy(): void {
    this.destroyed = true;
    for (const state of this.watchTimers.values()) {
      state.cancelled = true;
      if (state.timer !== undefined) clearTimeout(state.timer);
    }
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
