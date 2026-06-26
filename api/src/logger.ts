import { Writable } from 'stream';
import pino from 'pino';
import { config } from './config';

class AggregationStream extends Writable {
  private queue: string[] = [];
  private timer: NodeJS.Timeout | undefined;
  private readonly endpoint: string | undefined;
  private readonly headers: Record<string, string>;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;

  constructor(endpoint: string | undefined, headers: Record<string, string>, batchSize: number, flushIntervalMs: number) {
    super();
    this.endpoint = endpoint;
    this.headers = headers;
    this.batchSize = batchSize;
    this.flushIntervalMs = flushIntervalMs;
  }

  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    const line = chunk.toString();
    if (!this.endpoint) {
      process.stdout.write(line);
      callback();
      return;
    }

    this.queue.push(line);
    if (this.queue.length >= this.batchSize) {
      this.flushQueue().finally(() => callback());
      return;
    }

    this.scheduleFlush();
    callback();
  }

  _final(callback: (error?: Error | null) => void): void {
    this.flushQueue().finally(() => callback());
  }

  private scheduleFlush(): void {
    if (this.timer || !this.endpoint) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flushQueue();
    }, this.flushIntervalMs);
  }

  private async flushQueue(): Promise<void> {
    if (this.queue.length === 0 || !this.endpoint) return;
    const batch = this.queue.splice(0, this.queue.length);
    try {
      await fetch(this.endpoint, {
        method: 'POST',
        headers: this.headers,
        body: batch.join(''),
      });
    } catch {
      process.stdout.write(batch.join(''));
    }
  }
}

const aggregationEndpoint = process.env.LOG_AGGREGATION_URL || process.env.LOGTAIL_URL;
const aggregationHeaders: Record<string, string> = {
  'content-type': 'application/json',
};

if (process.env.LOGTAIL_TOKEN) {
  aggregationHeaders.authorization = `Bearer ${process.env.LOGTAIL_TOKEN}`;
}

const stream = new AggregationStream(
  aggregationEndpoint,
  aggregationHeaders,
  parseInt(process.env.LOG_AGGREGATION_BATCH_SIZE || '20', 10),
  parseInt(process.env.LOG_AGGREGATION_FLUSH_MS || '2000', 10),
);

export const logger = pino(
  {
    level: config.logLevel,
    base: {
      service: config.logging.serviceName,
      version: config.logging.version,
      env: config.logging.environment,
      instanceId: process.env.INSTANCE_ID || process.env.HOSTNAME || 'local',
    },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.x-api-key',
        'authorization',
        'password',
        'token',
        'apiKey',
      ],
      censor: '[REDACTED]',
    },
    serializers: {
      err: (err) => ({
        type: err.name,
        message: err.message,
        stack: err.stack,
      }),
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level(label) {
        return { level: label };
      },
    },
  },
  stream,
);
