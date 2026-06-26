import { QueueEntry, OfflineQueueOptions, StorageAdapter, RequestOptions } from './types';
import { BridgeClient, BridgeClientConfig } from './bridge';
import { OfflineError, QueueFullError, TimeoutError } from './errors';

const QUEUE_STORAGE_KEY = 'bridge_sdk_offline_queue';

type DrainHandler = (count: number, at: string) => void;

export class OfflineQueue {
  private queue: QueueEntry[] = [];
  private readonly maxSize: number;
  private readonly storage?: StorageAdapter;
  private healthTimer?: ReturnType<typeof setInterval>;
  private serverOnline = true;
  private replaying = false;
  private readonly drainHandlers: DrainHandler[] = [];

  constructor(
    private readonly executeEntry: (entry: QueueEntry) => Promise<unknown>,
    private readonly checkHealth: () => Promise<boolean>,
    options?: OfflineQueueOptions,
  ) {
    this.maxSize = options?.maxSize ?? 50;
    this.storage = options?.storageAdapter;
    const intervalMs = options?.healthCheckIntervalMs ?? 5_000;

    void this.loadFromStorage();

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
  }

  async enqueue(entry: Omit<QueueEntry, 'id' | 'timestamp' | 'retryCount'>): Promise<string> {
    if (this.queue.length >= this.maxSize) {
      throw new QueueFullError(this.maxSize);
    }
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const item: QueueEntry = { ...entry, id, timestamp: new Date().toISOString(), retryCount: 0 };
    this.queue.push(item);
    await this.persistToStorage();
    return id;
  }

  /** Returns a snapshot of all pending queue entries. */
  getQueue(): QueueEntry[] {
    return [...this.queue];
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
    if (this.healthTimer !== undefined) clearInterval(this.healthTimer);
  }

  private async replay(): Promise<void> {
    if (this.replaying || this.queue.length === 0) return;
    this.replaying = true;

    const remaining: QueueEntry[] = [];
    let processedCount = 0;

    for (const entry of this.queue) {
      try {
        await this.executeEntry(entry);
        processedCount++;
      } catch {
        entry.retryCount++;
        remaining.push(entry);
      }
    }

    this.queue = remaining;
    await this.persistToStorage();
    this.replaying = false;

    if (processedCount > 0) {
      const at = new Date().toISOString();
      for (const handler of this.drainHandlers) {
        try {
          handler(processedCount, at);
        } catch {}
      }
    }
  }

  private async loadFromStorage(): Promise<void> {
    if (!this.storage) return;
    try {
      const raw = await this.storage.get(QUEUE_STORAGE_KEY);
      if (raw) this.queue = JSON.parse(raw) as QueueEntry[];
    } catch {}
  }

  private async persistToStorage(): Promise<void> {
    if (!this.storage) return;
    try {
      await this.storage.set(QUEUE_STORAGE_KEY, JSON.stringify(this.queue));
    } catch {}
  }
}

export class OfflineBridgeClient extends BridgeClient {
  readonly offlineQueue: OfflineQueue;
  private readonly autoQueue: boolean;

  constructor(config: BridgeClientConfig & { offlineOptions?: OfflineQueueOptions }) {
    super(config);

    this.autoQueue = config.offlineOptions?.autoQueue ?? true;
    const healthPath = config.offlineOptions?.healthCheckPath ?? '/api/v1/health';
    const base = config.baseUrl.replace(/\/+$/, '');

    this.offlineQueue = new OfflineQueue(
      (entry) => this.executeQueueEntry(entry),
      () =>
        fetch(`${base}${healthPath}`, { method: 'GET' })
          .then((r) => r.ok)
          .catch(() => false),
      config.offlineOptions,
    );
  }

  protected override async request<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    params?: Record<string, string | undefined>,
    options?: RequestOptions,
  ): Promise<T> {
    try {
      return await super.request<T>(method, path, body, params, options);
    } catch (err) {
      if (this.autoQueue && this.isNetworkError(err)) {
        await this.offlineQueue.enqueue({ method, path, body, params });
        throw new OfflineError(true);
      }
      throw err;
    }
  }

  /** Inspect all pending queued requests. */
  getQueuedRequests(): QueueEntry[] {
    return this.offlineQueue.getQueue();
  }

  /** Discard all pending queued requests. */
  async clearQueue(): Promise<void> {
    return this.offlineQueue.clearQueue();
  }

  /** Register a callback that fires when the queue is fully drained after reconnection. */
  onQueueDrained(handler: (count: number, at: string) => void): void {
    this.offlineQueue.onDrained(handler);
  }

  destroy(): void {
    this.offlineQueue.destroy();
  }

  private isNetworkError(err: unknown): boolean {
    if (err instanceof TimeoutError) return false;
    if (err instanceof TypeError) return true;
    if (err instanceof Error) {
      const msg = err.message.toLowerCase();
      return (
        msg.includes('failed to fetch') ||
        msg.includes('network') ||
        msg.includes('econnrefused') ||
        msg.includes('enotfound')
      );
    }
    return false;
  }

  private async executeQueueEntry(entry: QueueEntry): Promise<unknown> {
    return super.request(entry.method, entry.path, entry.body, entry.params);
  }
}
