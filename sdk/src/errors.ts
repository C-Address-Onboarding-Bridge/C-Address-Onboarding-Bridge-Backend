import { translate } from './i18n';
import type { SupportedLocale } from './i18n/types';

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

  constructor(message?: string, options?: { statusCode?: 401 | 403; code?: string; cause?: unknown; locale?: SupportedLocale }) {
    const statusCode = options?.statusCode ?? 401;
    const resolvedMessage =
      message ?? translate(options?.locale, statusCode === 403 ? 'error.auth.forbidden' : 'error.auth.unauthorized');
    super(resolvedMessage, { statusCode, code: options?.code, retryable: false, cause: options?.cause });
    this.name = 'AuthError';
  }
}

export class ValidationError extends BridgeError {
  override readonly type = 'ValidationError' as const;
  readonly fields: Record<string, string> | undefined;

  constructor(message: string, options?: { statusCode?: 400 | 422; code?: string; fields?: Record<string, string>; cause?: unknown; locale?: SupportedLocale }) {
    super(message, { statusCode: options?.statusCode ?? 400, code: options?.code, retryable: false, cause: options?.cause });
    this.name = 'ValidationError';
    this.fields = options?.fields;
  }
}

export class RateLimitError extends BridgeError {
  override readonly type = 'RateLimitError' as const;
  readonly retryAfterMs: number | undefined;

  constructor(message?: string, options?: { retryAfterMs?: number; code?: string; cause?: unknown; locale?: SupportedLocale }) {
    const resolvedMessage =
      message ??
      (options?.retryAfterMs !== undefined
        ? translate(options.locale, 'error.rate_limit.retry_after', { seconds: Math.ceil(options.retryAfterMs / 1000) })
        : translate(options?.locale, 'error.rate_limit'));
    super(resolvedMessage, { statusCode: 429, code: options?.code, retryable: true, cause: options?.cause });
    this.name = 'RateLimitError';
    this.retryAfterMs = options?.retryAfterMs;
  }
}

export class ServerError extends BridgeError {
  override readonly type = 'ServerError' as const;

  constructor(message?: string, options?: { statusCode?: number; code?: string; cause?: unknown; locale?: SupportedLocale }) {
    const resolvedMessage = message ?? translate(options?.locale, 'error.server');
    super(resolvedMessage, { statusCode: options?.statusCode ?? 500, code: options?.code, retryable: true, cause: options?.cause });
    this.name = 'ServerError';
  }
}

export class NotFoundError extends BridgeError {
  override readonly type = 'NotFoundError' as const;

  constructor(message?: string, options?: { code?: string; cause?: unknown; locale?: SupportedLocale }) {
    const resolvedMessage = message ?? translate(options?.locale, 'error.not_found');
    super(resolvedMessage, { statusCode: 404, code: options?.code, retryable: false, cause: options?.cause });
    this.name = 'NotFoundError';
  }
}

// ─── Network / transport errors ───────────────────────────────────────────────

export class NetworkError extends BridgeError {
  override readonly type = 'NetworkError' as const;

  constructor(message?: string, options?: { code?: string; cause?: unknown; locale?: SupportedLocale }) {
    const resolvedMessage = message ?? translate(options?.locale, 'error.network');
    super(resolvedMessage, { retryable: true, code: options?.code, cause: options?.cause });
    this.name = 'NetworkError';
  }
}

export class TimeoutError extends BridgeError {
  override readonly type = 'TimeoutError' as const;
  readonly timeoutMs: number;
  readonly operation: string;

  constructor(operation: string, timeoutMs: number, options?: { locale?: SupportedLocale }) {
    super(translate(options?.locale, 'error.timeout', { operation, ms: timeoutMs }), { retryable: true });
    this.name = 'TimeoutError';
    this.timeoutMs = timeoutMs;
    this.operation = operation;
  }
}

// ─── Offline / queue errors ───────────────────────────────────────────────────

export class OfflineError extends BridgeError {
  override readonly type = 'OfflineError' as const;
  readonly queued: boolean;

  constructor(queued = false, options?: { locale?: SupportedLocale }) {
    super(
      translate(options?.locale, queued ? 'error.offline.queued' : 'error.offline.not_queued'),
      { retryable: false },
    );
    this.name = 'OfflineError';
    this.queued = queued;
  }
}

export class QueueFullError extends BridgeError {
  override readonly type = 'QueueFullError' as const;
  readonly maxSize: number;

  constructor(maxSize: number, options?: { locale?: SupportedLocale }) {
    super(translate(options?.locale, 'error.queue_full', { max: maxSize }), { retryable: false });
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

export function parseHttpError(status: number, body: ErrorBody, cause?: unknown, locale?: SupportedLocale): BridgeError {
  throw new Error('Not implemented: parseHttpError');
}

// ─── Type guard helpers ────────────────────────────────────────────────────────

export function isAuthError(err: unknown): err is AuthError {
  return err instanceof AuthError;
}

export function isValidationError(err: unknown): err is ValidationError {
  throw new Error('Not implemented: isValidationError');
}

export function isRateLimitError(err: unknown): err is RateLimitError {
  throw new Error('Not implemented: isRateLimitError');
}

export function isServerError(err: unknown): err is ServerError {
  throw new Error('Not implemented: isServerError');
}

export function isNetworkError(err: unknown): err is NetworkError {
  throw new Error('Not implemented: isNetworkError');
}

export function isTimeoutError(err: unknown): err is TimeoutError {
  throw new Error('Not implemented: isTimeoutError');
}

export function isNotFoundError(err: unknown): err is NotFoundError {
  throw new Error('Not implemented: isNotFoundError');
}

export function isBridgeError(err: unknown): err is BridgeError {
  throw new Error('Not implemented: isBridgeError');
}
