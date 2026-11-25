import {
  BridgeEventType,
  BridgeEvent,
  BridgeEventDataMap,
  EventHandler,
  EventEmitterOptions,
  TransactionStatus,
} from './types.js';
import { BridgeError } from './errors.js';
import { unrefTimer } from './utils.js';

type StatusFetcher = (txHash: string) => Promise<TransactionStatus>;
type HealthChecker = () => Promise<boolean>;

interface WatchState {
  timer?: ReturnType<typeof setTimeout>;
  cancelled: boolean;
  consecutiveErrors: number;
  currentDelayMs: number;
}

/** Base multiplier for exponential backoff on retryable errors. */
const BACKOFF_BASE = 2;
/** Cap on a single poll delay regardless of error count (30 s). */
const MAX_BACKOFF_MS = 30_000;

export class BridgeEventEmitter {
  private readonly handlers = new Map<BridgeEventType, Set<EventHandler<BridgeEventType>>>();
  private readonly history: BridgeEvent[] = [];
  private readonly historySize: number;
  private readonly pollIntervalMs: number;
  private readonly healthCheckIntervalMs: number;
  private readonly maxConsecutiveErrors: number;
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
    this.maxConsecutiveErrors = options?.maxConsecutiveErrors ?? 10;

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

    const state: WatchState = {
      cancelled: false,
      consecutiveErrors: 0,
      currentDelayMs: this.pollIntervalMs,
    };
    this.watchTimers.set(txHash, state);

    const scheduleNext = (delayMs: number): void => {
      if (state.cancelled || this.destroyed) return;
      state.timer = setTimeout(() => {
        void tick();
      }, delayMs);
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

        // Non-retryable BridgeErrors (404, 401, 422, …) must stop immediately.
        // Polling again would only hammer the API and fill the history buffer.
        if (err instanceof BridgeError && !err.retryable) {
          this.emit('error', {
            message: `Polling stopped: non-retryable error for ${txHash}`,
            error: err,
          });
          this.unwatch(txHash);
          return;
        }

        // Retryable errors (503, network, …) — back off exponentially.
        state.consecutiveErrors++;
        this.emit('error', { message: 'Failed to poll transaction status', error: err });

        if (state.consecutiveErrors >= this.maxConsecutiveErrors) {
          this.emit('error', {
            message: `Polling aborted after ${state.consecutiveErrors} consecutive errors for ${txHash}`,
            error: err,
          });
          this.unwatch(txHash);
          return;
        }

        // Exponential backoff capped at MAX_BACKOFF_MS.
        const backoff = Math.min(
          this.pollIntervalMs * Math.pow(BACKOFF_BASE, state.consecutiveErrors - 1),
          MAX_BACKOFF_MS,
        );
        state.currentDelayMs = backoff;
        scheduleNext(backoff);
        return;
      }

      // Re-check cancellation after the await.
      if (state.cancelled || this.destroyed) return;

      // Successful fetch resets the error counter and backoff.
      state.consecutiveErrors = 0;
      state.currentDelayMs = this.pollIntervalMs;

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
      scheduleNext(this.pollIntervalMs);
    };

    scheduleNext(this.pollIntervalMs);
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
    if (this.healthTimer !== undefined) {
      clearInterval(this.healthTimer);
      this.healthTimer = undefined;
    }
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
    unrefTimer(this.healthTimer);
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

