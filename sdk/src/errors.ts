export class TimeoutError extends Error {
  readonly type = 'TimeoutError' as const;
  readonly timeoutMs: number;
  readonly operation: string;

  constructor(operation: string, timeoutMs: number) {
    super(`Operation "${operation}" timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
    this.timeoutMs = timeoutMs;
    this.operation = operation;
    Object.setPrototypeOf(this, TimeoutError.prototype);
  }
}

export class OfflineError extends Error {
  readonly type = 'OfflineError' as const;
  readonly queued: boolean;

  constructor(queued = false) {
    super(
      queued
        ? 'Client is offline; request was queued for replay when connectivity is restored'
        : 'Client is offline; request was not queued',
    );
    this.name = 'OfflineError';
    this.queued = queued;
    Object.setPrototypeOf(this, OfflineError.prototype);
  }
}

export class QueueFullError extends Error {
  readonly type = 'QueueFullError' as const;
  readonly maxSize: number;

  constructor(maxSize: number) {
    super(`Offline queue is full (max ${maxSize} entries); request was dropped`);
    this.name = 'QueueFullError';
    this.maxSize = maxSize;
    Object.setPrototypeOf(this, QueueFullError.prototype);
  }
}
