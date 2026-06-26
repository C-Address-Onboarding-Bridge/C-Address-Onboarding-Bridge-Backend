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

export class TelemetryClient {
  private readonly transport: TelemetryTransport;
  private readonly enabled: boolean;
  private readonly flushIntervalMs: number;
  private readonly queue: TelemetryEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: { endpoint?: string; enabled?: boolean; intervalMs?: number; transport?: TelemetryTransport } = {}) {
    const runtimeProcess = typeof process !== 'undefined' ? process : undefined;
    this.enabled = options.enabled ?? (runtimeProcess?.env?.SDK_TELEMETRY_ENABLED !== 'false');
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

    const runtimeProcess = typeof process !== 'undefined' ? process : undefined;
    this.queue.push({
      sdkVersion: runtimeProcess?.env?.npm_package_version || '0.1.0',
      nodeVersion: runtimeProcess?.version || 'unknown',
      platform: runtimeProcess?.platform || 'unknown',
      ...event,
    });
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

  private flush(): void {
    if (this.queue.length === 0) {
      return;
    }

    const batch = this.queue.splice(0, this.queue.length);
    batch.forEach((event) => this.transport.send(event));
  }
}
