// ─── Base ─────────────────────────────────────────────────────────────────────

export class BridgeError extends Error {
  readonly type: string = 'BridgeError';
  readonly statusCode: number | undefined;
  readonly code: string | undefined;
  readonly retryable: boolean;

  constructor(message: string, options?: { statusCode?: number; code?: string; retryable?: boolean; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'BridgeError';
    this.statusCode = options?.statusCode;
    this.code = options?.code;
    this.retryable = options?.retryable ?? false;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  static isRetryable(err: unknown): boolean {
    return err instanceof BridgeError && err.retryable;
  }
}

// ─── HTTP-derived errors ───────────────────────────────────────────────────────

export class AuthError extends BridgeError {
  override readonly type = 'AuthError' as const;

  constructor(message = 'Unauthorized', options?: { statusCode?: 401 | 403; code?: string; cause?: unknown }) {
    super(message, { statusCode: options?.statusCode ?? 401, code: options?.code, retryable: false, cause: options?.cause });
    this.name = 'AuthError';
  }
}

export class ValidationError extends BridgeError {
  override readonly type = 'ValidationError' as const;
  readonly fields: Record<string, string> | undefined;

  constructor(message: string, options?: { statusCode?: 400 | 422; code?: string; fields?: Record<string, string>; cause?: unknown }) {
    super(message, { statusCode: options?.statusCode ?? 400, code: options?.code, retryable: false, cause: options?.cause });
    this.name = 'ValidationError';
    this.fields = options?.fields;
  }
}

export class RateLimitError extends BridgeError {
  override readonly type = 'RateLimitError' as const;
  readonly retryAfterMs: number | undefined;

  constructor(message = 'Too many requests', options?: { retryAfterMs?: number; code?: string; cause?: unknown }) {
    super(message, { statusCode: 429, code: options?.code, retryable: true, cause: options?.cause });
    this.name = 'RateLimitError';
    this.retryAfterMs = options?.retryAfterMs;
  }
}

export class ServerError extends BridgeError {
  override readonly type = 'ServerError' as const;

  constructor(message: string, options?: { statusCode?: number; code?: string; cause?: unknown }) {
    super(message, { statusCode: options?.statusCode ?? 500, code: options?.code, retryable: true, cause: options?.cause });
    this.name = 'ServerError';
  }
}

export class NotFoundError extends BridgeError {
  override readonly type = 'NotFoundError' as const;

  constructor(message = 'Not found', options?: { code?: string; cause?: unknown }) {
    super(message, { statusCode: 404, code: options?.code, retryable: false, cause: options?.cause });
    this.name = 'NotFoundError';
  }
}

// ─── Network / transport errors ───────────────────────────────────────────────

export class NetworkError extends BridgeError {
  override readonly type = 'NetworkError' as const;

  constructor(message = 'Network error', options?: { code?: string; cause?: unknown }) {
    super(message, { retryable: true, code: options?.code, cause: options?.cause });
    this.name = 'NetworkError';
  }
}

export class TimeoutError extends BridgeError {
  override readonly type = 'TimeoutError' as const;
  readonly timeoutMs: number;
  readonly operation: string;

  constructor(operation: string, timeoutMs: number) {
    super(`Operation "${operation}" timed out after ${timeoutMs}ms`, { retryable: true });
    this.name = 'TimeoutError';
    this.timeoutMs = timeoutMs;
    this.operation = operation;
  }
}

// ─── Offline / queue errors ───────────────────────────────────────────────────

export class OfflineError extends BridgeError {
  override readonly type = 'OfflineError' as const;
  readonly queued: boolean;

  constructor(queued = false) {
    super(
      queued
        ? 'Client is offline; request was queued for replay when connectivity is restored'
        : 'Client is offline; request was not queued',
      { retryable: false },
    );
    this.name = 'OfflineError';
    this.queued = queued;
  }
}

export class QueueFullError extends BridgeError {
  override readonly type = 'QueueFullError' as const;
  readonly maxSize: number;

  constructor(maxSize: number) {
    super(`Offline queue is full (max ${maxSize} entries); request was dropped`, { retryable: false });
    this.name = 'QueueFullError';
    this.maxSize = maxSize;
  }
}

// ─── Factory: parse HTTP response into typed error ────────────────────────────

interface ErrorBody {
  message?: string;
  code?: string;
  fields?: Record<string, string>;
  retryAfter?: number;
}

export function parseHttpError(status: number, body: ErrorBody, cause?: unknown): BridgeError {
  const msg = body.message || `Request failed with status ${status}`;
  const code = body.code;

  if (status === 401 || status === 403) {
    return new AuthError(msg, { statusCode: status as 401 | 403, code, cause });
  }
  if (status === 404) {
    return new NotFoundError(msg, { code, cause });
  }
  if (status === 400 || status === 422) {
    return new ValidationError(msg, { statusCode: status as 400 | 422, code, fields: body.fields, cause });
  }
  if (status === 429) {
    return new RateLimitError(msg, {
      code,
      retryAfterMs: body.retryAfter !== undefined ? body.retryAfter * 1000 : undefined,
      cause,
    });
  }
  if (status >= 500) {
    return new ServerError(msg, { statusCode: status, code, cause });
  }
  return new BridgeError(msg, { statusCode: status, code, retryable: false, cause });
}

// ─── Type guard helpers ────────────────────────────────────────────────────────

export function isAuthError(err: unknown): err is AuthError {
  return err instanceof AuthError;
}

export function isValidationError(err: unknown): err is ValidationError {
  return err instanceof ValidationError;
}

export function isRateLimitError(err: unknown): err is RateLimitError {
  return err instanceof RateLimitError;
}

export function isServerError(err: unknown): err is ServerError {
  return err instanceof ServerError;
}

export function isNetworkError(err: unknown): err is NetworkError {
  return err instanceof NetworkError;
}

export function isTimeoutError(err: unknown): err is TimeoutError {
  return err instanceof TimeoutError;
}

export function isNotFoundError(err: unknown): err is NotFoundError {
  return err instanceof NotFoundError;
}

export function isBridgeError(err: unknown): err is BridgeError {
  return err instanceof BridgeError;
}
