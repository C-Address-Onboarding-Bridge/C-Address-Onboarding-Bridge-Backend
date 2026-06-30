import { Writable } from 'stream';
import pino from 'pino';
import { config } from './config';

const LOG_RATE_LIMIT_PER_SEC = parseInt(process.env.LOG_RATE_LIMIT_PER_SEC || '100', 10);
let logCountThisSecond = 0;
let logRateWindowStart = Date.now();
let droppedLogCount = 0;

function shouldDropLog(): boolean {
  const now = Date.now();
  if (now - logRateWindowStart >= 1000) {
    if (droppedLogCount > 0) {
      process.stdout.write(JSON.stringify({
        level: 'warn',
        msg: 'log rate limit: dropped messages',
        dropped: droppedLogCount,
        service: config.logging.serviceName,
      }) + '\n');
    }
    logCountThisSecond = 0;
    droppedLogCount = 0;
    logRateWindowStart = now;
  }
  logCountThisSecond++;
  if (logCountThisSecond > LOG_RATE_LIMIT_PER_SEC) {
    droppedLogCount++;
    return true;
  }
  return false;
}

class AggregationStream extends Writable {
  private queue: string[] = [];
  private timer: NodeJS.Timeout | undefined;
  private readonly endpoint: string | undefined;
  private readonly headers: Record<string, string>;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly lokiMode: boolean;

  constructor(
    endpoint: string | undefined,
    headers: Record<string, string>,
    batchSize: number,
    flushIntervalMs: number,
    lokiMode: boolean,
  ) {
    super();
    this.endpoint = endpoint;
    this.headers = headers;
    this.batchSize = batchSize;
    this.flushIntervalMs = flushIntervalMs;
    this.lokiMode = lokiMode;
  }

  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (shouldDropLog()) {
      callback();
      return;
    }

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

  private formatBatch(batch: string[]): string {
    if (!this.lokiMode) return batch.join('');

    const streams = batch.map((line) => {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(line);
      } catch {
        parsed = { msg: line };
      }
      const ts = parsed.time ? new Date(String(parsed.time)).getTime() * 1_000_000 : Date.now() * 1_000_000;
      const labels = {
        job: config.logging.serviceName,
        env: config.logging.environment,
        level: String(parsed.level ?? 'info'),
        service: config.logging.serviceName,
      };
      return {
        stream: labels,
        values: [[String(ts), line.trim()]],
      };
    });

    return JSON.stringify({ streams });
  }

  private async flushQueue(): Promise<void> {
    if (this.queue.length === 0 || !this.endpoint) return;
    const batch = this.queue.splice(0, this.queue.length);
    const body = this.formatBatch(batch);
    try {
      await fetch(this.endpoint, {
        method: 'POST',
        headers: this.headers,
        body,
      });
    } catch {
      process.stdout.write(batch.join(''));
    }
  }
}

const aggregationEndpoint = process.env.LOG_AGGREGATION_URL || process.env.LOGTAIL_URL;
const lokiPushUrl = process.env.LOKI_PUSH_URL;
const endpoint = lokiPushUrl || aggregationEndpoint;
const lokiMode = Boolean(lokiPushUrl);

const aggregationHeaders: Record<string, string> = {
  'content-type': lokiMode ? 'application/json' : 'application/json',
};

if (process.env.LOGTAIL_TOKEN) {
  aggregationHeaders.authorization = `Bearer ${process.env.LOGTAIL_TOKEN}`;
}

const sensitivePaths = [
  'req.headers.authorization',
  'req.headers["x-api-key"]',
  'authorization',
  'password',
  'token',
  'apiKey',
  'signedXdr',
  'privateKey',
  'mnemonic',
  'secret',
  'secretKey',
  ...config.logging.sensitiveFields
    .map((f) => f.trim())
    .filter(Boolean)
    .filter((f) => !f.includes('-'))
    .map((f) => (f.includes('.') ? f : f)),
];

const stream = new AggregationStream(
  endpoint,
  aggregationHeaders,
  parseInt(process.env.LOG_AGGREGATION_BATCH_SIZE || '20', 10),
  parseInt(process.env.LOG_AGGREGATION_FLUSH_MS || '2000', 10),
  lokiMode,
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
      paths: sensitivePaths,
      censor: '[REDACTED]',
    },
    serializers: {
      err: (err) => ({
        type: err.name,
        message: err.message,
        stack: err.stack,
        error_code: (err as NodeJS.ErrnoException).code,
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
