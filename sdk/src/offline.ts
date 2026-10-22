import { QueueEntry, OfflineQueueOptions, StorageAdapter, RequestOptions, HttpMethod } from './types';
import { BridgeClient, BridgeClientConfig } from './bridge';
import { OfflineError, QueueFullError, TimeoutError, NetworkError } from './errors';
import type { SupportedLocale } from './i18n/types';
import { unrefTimer } from './utils';

const QUEUE_STORAGE_KEY = 'bridge_sdk_offline_queue';

/**
 * Non-idempotent POST paths: replaying these without a stable idempotency key
 * risks duplicate side-effects (e.g. double CEX withdrawal). We still allow
 * them to be queued, but we always attach the idempotency key that was
 * generated at enqueue time so the server can deduplicate.
 */
const NON_IDEMPOTENT_POST_PATHS: ReadonlySet<string> = new Set([
  '/api/v1/offramp/moonpay',
  '/api/v1/offramp/transak',
  '/api/v1/cex/route',
  '/api/v1/fund',
]);

type DrainHandler = (count: number, at: string) => void;

export class OfflineQueue {
  private queue: QueueEntry[] = [];
  private readonly maxSize: number;
  private readonly maxRetries: number;
  private readonly shouldRetry: (err: unknown) => boolean;
  private readonly storage?: StorageAdapter;
  private healthTimer?: ReturnType<typeof setInterval>;
  private serverOnline = true;
  private replaying = false;
  private readonly drainHandlers: DrainHandler[] = [];
  private readonly deadLetters: QueueEntry[] = [];

  /**
   * Promise that resolves once the initial storage load is complete.
   * enqueue() awaits this so that a concurrent storage load cannot overwrite
   * entries that were enqueued before the load finished (#261).
   */
  private readonly storageReady: Promise<void>;

  /** Mirrors OfflineBridgeClient.locale; assigned from options in the ctor. */
  private readonly locale?: SupportedLocale;

  constructor(
    private readonly executeEntry: (entry: QueueEntry) => Promise<unknown>,
    private readonly checkHealth: () => Promise<boolean>,
    options?: OfflineQueueOptions,
  ) {
    this.maxSize = options?.maxSize ?? 50;
    this.maxRetries = options?.maxRetries ?? 3;
    this.shouldRetry = options?.shouldRetry ?? (() => true);
    this.storage = options?.storageAdapter;
    this.locale = options?.locale;
    const intervalMs = options?.healthCheckIntervalMs ?? 5_000;

    // #261 fix: capture the load promise so enqueue() can await it.
    this.storageReady = this.loadFromStorage();

    this.healthTimer = setInterval(async () => {
      try {
        const online = await this.checkHealth();
        if (!this.serverOnline && online) {
          this.serverOnline = true;
          await this.replay();
        } else if (this.serverOnline && !online) {
          this.serverOnline = false;
        }
      } catch {
        if (this.serverOnline) this.serverOnline = false;
      }
    }, intervalMs);
    // The health poll is background housekeeping: it must not keep a Node
    // process (or a test runner, or an SSR request) alive on its own.
    unrefTimer(this.healthTimer);
  }

  async enqueue(entry: Omit<QueueEntry, 'id' | 'timestamp' | 'retryCount'>): Promise<string> {
    // #261 fix: wait for the initial storage load before modifying the queue
    // so the load cannot overwrite entries added before it completes.
    await this.storageReady;

    if (this.queue.length >= this.maxSize) {
      throw new QueueFullError(this.maxSize, { locale: this.locale });
    }
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    // #262 fix: generate a stable idempotency key once at enqueue time for
    // non-idempotent POST operations. The same key is sent on every replay so
    // the server can deduplicate submissions caused by connection failures.
    // #846 fix: when the caller already supplied the key used on the failed
    // attempt, reuse it verbatim so a replay cannot duplicate a submission
    // that may have reached the server.
    const idempotencyKey =
      entry.method === 'POST' && NON_IDEMPOTENT_POST_PATHS.has(entry.path)
        ? entry.idempotencyKey ?? generateIdempotencyKey()
        : entry.idempotencyKey;

    const item: QueueEntry = {
      ...entry,
      id,
      timestamp: new Date().toISOString(),
      retryCount: 0,
      idempotencyKey,
    };
    this.queue.push(item);
    await this.persistToStorage();
    return id;
  }

  /** Returns a snapshot of all pending queue entries. */
  getQueue(): QueueEntry[] {
    return [...this.queue];
  }

  /** Inspect all entries that exceeded max retries or were non-retryable. */
  getDeadLetters(): QueueEntry[] {
    return [...this.deadLetters];
  }

  /** Removes all pending entries and clears persisted storage. */
  async clearQueue(): Promise<void> {
    this.queue = [];
    if (this.storage) await this.storage.remove(QUEUE_STORAGE_KEY);
  }

  /** Register a callback invoked when the queue is fully drained after replay. */
  onDrained(handler: DrainHandler): void {
    this.drainHandlers.push(handler);
  }

  /** Manually signal connectivity state; triggers replay when transitioning online. */
  setOnline(online: boolean): void {
    const wasOffline = !this.serverOnline;
    this.serverOnline = online;
    if (wasOffline && online) void this.replay();
  }

  destroy(): void {
    if (this.healthTimer !== undefined) {
      clearInterval(this.healthTimer);
      this.healthTimer = undefined;
    }
  }

  private async replay(): Promise<void> {
    if (this.replaying || this.queue.length === 0) return;
    this.replaying = true;

    let processedCount = 0;

    try {
      // #849 fix: iterate a snapshot and remove each processed entry by id
      // instead of reassigning this.queue. Entries enqueued (or cleared) while
      // the replay is awaiting executeEntry() are preserved.
      const snapshot = [...this.queue];

      for (const entry of snapshot) {
        try {
          await this.executeEntry(entry);
          processedCount++;
          this.removeById(entry.id);
        } catch (err) {
          if (!this.shouldRetry(err)) {
            this.deadLetters.push(entry);
            this.removeById(entry.id);
            continue;
          }
          entry.retryCount++;
          if (entry.retryCount >= this.maxRetries) {
            this.deadLetters.push(entry);
            this.removeById(entry.id);
            continue;
          }
          // Keep the entry queued for a later replay; retryCount is persisted
          // below via persistToStorage().
        }
      }

      await this.persistToStorage();
    } finally {
      // #849 fix: always reset the replaying flag, even if executeEntry()
      // throws something shouldRetry() does not handle.
      this.replaying = false;
    }

    if (processedCount > 0) {
      const at = new Date().toISOString();
      for (const handler of this.drainHandlers) {
        try {
          handler(processedCount, at);
        } catch {}
      }
    }
  }

  /** Removes a single entry from the queue by id, preserving all others. */
  private removeById(id: string): void {
    const idx = this.queue.findIndex((e) => e.id === id);
    if (idx !== -1) this.queue.splice(idx, 1);
  }

  private async loadFromStorage(): Promise<void> {
    if (!this.storage) return;
    try {
      const raw = await this.storage.get(QUEUE_STORAGE_KEY);
      if (raw) {
        const loaded = JSON.parse(raw) as QueueEntry[];
        // #261 fix: merge loaded entries with any already-enqueued in-memory
        // entries instead of replacing them outright. This prevents the async
        // load from silently discarding items that were enqueued before it
        // resolved. We deduplicate by id so re-loading the same entries is safe.
        const existingIds = new Set(this.queue.map((e) => e.id));
        for (const entry of loaded) {
          if (!existingIds.has(entry.id)) {
            this.queue.push(entry);
          }
        }
      }
    } catch {}
  }

  private async persistToStorage(): Promise<void> {
    if (!this.storage) return;
    try {
      await this.storage.set(QUEUE_STORAGE_KEY, JSON.stringify(this.queue));
    } catch {}
  }
}

// Import shared idempotency key generator from utils
import { generateIdempotencyKey } from './utils';

export class OfflineBridgeClient extends BridgeClient {
  readonly offlineQueue: OfflineQueue;
  private readonly autoQueue: boolean;
  private readonly locale?: SupportedLocale;

  constructor(config: BridgeClientConfig & { offlineOptions?: OfflineQueueOptions }) {
    super(config);

    this.autoQueue = config.offlineOptions?.autoQueue ?? true;
    this.locale = config.locale;
    // #840 fix: the API serves health at the root (`/health`, `/health/live`,
    // `/health/ready`), not under `/api/v1`. Defaulting to `/api/v1/health`
    // always 404'd, so the queue never observed an offline->online transition
    // and never replayed. Align with BridgeClient.health() which uses `/health`.
    const healthPath = config.offlineOptions?.healthCheckPath ?? '/health';
    const base = config.baseUrl.replace(/\/+$/, '');

    this.offlineQueue = new OfflineQueue(
      (entry) => this.executeQueueEntry(entry),
      () =>
        fetch(`${base}${healthPath}`, { method: 'GET' })
          .then((r) => r.ok)
          .catch(() => false),
      {
        ...config.offlineOptions,
        shouldRetry: (err) => this.shouldRetry(err),
      },
    );
  }

  protected override async request<T>(
    method: HttpMethod,
    path: string,
    body?: Record<string, unknown>,
    params?: Record<string, string | undefined>,
    options?: RequestOptions,
    idempotencyKey?: string,
  ): Promise<T> {
    try {
      return await super.request<T>(method, path, body, params, options, idempotencyKey);
    } catch (err) {
      if (this.autoQueue && this.isNetworkError(err)) {
        const id = await this.offlineQueue.enqueue({
          method,
          path,
          body,
          params,
          idempotencyKey,
        });
        throw new OfflineError(id, { locale: this.locale });
      }
      throw err;
    }
  }

  private async executeQueueEntry(entry: QueueEntry): Promise<unknown> {
    return super.request(
      entry.method,
      entry.path,
      entry.body,
      entry.params,
      undefined,
      entry.idempotencyKey,
    );
  }

  private shouldRetry(err: unknown): boolean {
    return this.isNetworkError(err);
  }

  private isNetworkError(err: unknown): boolean {
    if (err instanceof TimeoutError) return false;
    // #843 fix: by the time super.request() rejects, a fetch TypeError has
    // already been wrapped into a NetworkError (a BridgeError). Check the
    // type directly so Node/undici ("fetch failed") and Safari ("Load failed")
    // are recognised, not just Chrome/Firefox message text.
    if (err instanceof NetworkError) return true;
    if (err instanceof TypeError) return true;
    if (err instanceof Error) {
      const msg = err.message.toLowerCase();
      return (
        msg.includes('failed to fetch') ||
        msg.includes('fetch failed') ||
        msg.includes('load failed') ||
        msg.includes('network') ||
        msg.includes('econnrefused') ||
        msg.includes('enotfound')
      );
    }
    return false;
  }
}
