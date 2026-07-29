export interface TelemetryEvent {
  sdkVersion: string;
  nodeVersion: string;
  platform: string;
  method: string;
  responseTimeMs: number;
  errorType?: string;
}

export interface TelemetryTransport {
  send(event: TelemetryEvent): void;
}

export class NoopTelemetryTransport implements TelemetryTransport {
  send(_event: TelemetryEvent): void {
    // no-op by default
  }
}

export class FetchTelemetryTransport implements TelemetryTransport {
  constructor(private readonly endpoint: string) {}

  send(event: TelemetryEvent): void {
    void fetch(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    }).catch(() => undefined);
  }
}

/** Maximum number of events held in the in-memory queue when no flush can occur. */
const MAX_QUEUE_SIZE = 100;

export class TelemetryClient {
  private readonly transport: TelemetryTransport;
  private readonly enabled: boolean;
  private readonly flushIntervalMs: number;
  private readonly queue: TelemetryEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  /** True when a real endpoint is configured and flush is scheduled. */
  private readonly hasEndpoint: boolean;

  constructor(options: { endpoint?: string; enabled?: boolean; intervalMs?: number; transport?: TelemetryTransport } = {}) {
    const runtimeProcess = typeof process !== 'undefined' ? process : undefined;
    this.hasEndpoint = Boolean(options.endpoint || options.transport);
    // Default enabled to false when no endpoint is configured to prevent the
    // queue from growing unboundedly with no flush ever triggered (#258).
    const defaultEnabled = this.hasEndpoint
      ? runtimeProcess?.env?.SDK_TELEMETRY_ENABLED !== 'false'
      : false;
    this.enabled = options.enabled ?? defaultEnabled;
    this.flushIntervalMs = options.intervalMs ?? 60_000;
    this.transport = options.transport ?? (options.endpoint ? new FetchTelemetryTransport(options.endpoint) : new NoopTelemetryTransport());

    if (this.enabled && options.endpoint) {
      this.start();
    }
  }

  record(event: Omit<TelemetryEvent, 'sdkVersion' | 'nodeVersion' | 'platform'>): void {
    if (!this.enabled) {
      return;
    }

    // Safety cap: if the queue is full (e.g. flush is lagging) drop the oldest
    // entry so memory usage stays bounded regardless of flush frequency.
    if (this.queue.length >= MAX_QUEUE_SIZE) {
      this.queue.shift();
    }

    const runtimeProcess = typeof process !== 'undefined' ? process : undefined;
    this.queue.push({
      sdkVersion: runtimeProcess?.env?.npm_package_version || '0.1.0',
      nodeVersion: runtimeProcess?.version || 'unknown',
      platform: runtimeProcess?.platform || 'unknown',
      ...event,
    });
  }

  /** Returns the number of events currently held in the queue. */
  getQueueSize(): number {
    return this.queue.length;
  }

  /** Manually flush all queued events through the transport. */
  flush(): void {
    if (this.queue.length === 0) {
      return;
    }

    const batch = this.queue.splice(0, this.queue.length);
    batch.forEach((event) => this.transport.send(event));
  }

  private start(): void {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      this.flush();
    }, this.flushIntervalMs);

    if (this.timer.unref) {
      this.timer.unref();
    }
  }
}
