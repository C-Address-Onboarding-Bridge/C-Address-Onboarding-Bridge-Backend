import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vi } from 'vitest';
import { BridgeClient } from '../src/bridge';
import {
  BridgeError,
  AuthError,
  ValidationError,
  RateLimitError,
  ServerError,
  NotFoundError,
  NetworkError,
  TimeoutError,
  parseHttpError,
  isAuthError,
  isValidationError,
  isRateLimitError,
  isServerError,
  isNetworkError,
  isNotFoundError,
  isBridgeError,
  isTimeoutError,
} from '../src/errors';

// ─── parseHttpError factory ───────────────────────────────────────────────────

describe('parseHttpError', () => {
  it('maps 401 to AuthError', () => {
    const err = parseHttpError(401, { message: 'Unauthorized' });
    expect(err).toBeInstanceOf(AuthError);
    expect(err.statusCode).toBe(401);
    expect(err.retryable).toBe(false);
  });

  it('maps 403 to AuthError', () => {
    const err = parseHttpError(403, { message: 'Forbidden' });
    expect(err).toBeInstanceOf(AuthError);
    expect(err.statusCode).toBe(403);
  });

  it('maps 400 to ValidationError', () => {
    const err = parseHttpError(400, { message: 'Bad input', fields: { amount: 'must be positive' } });
    expect(err).toBeInstanceOf(ValidationError);
    const ve = err as ValidationError;
    expect(ve.fields).toEqual({ amount: 'must be positive' });
    expect(ve.retryable).toBe(false);
  });

  it('maps 422 to ValidationError', () => {
    const err = parseHttpError(422, { message: 'Unprocessable' });
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.statusCode).toBe(422);
  });

  it('maps 404 to NotFoundError', () => {
    const err = parseHttpError(404, { message: 'Not found' });
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.statusCode).toBe(404);
    expect(err.retryable).toBe(false);
  });

  it('maps 429 to RateLimitError', () => {
    const err = parseHttpError(429, { message: 'Rate limit', retryAfter: 5 });
    expect(err).toBeInstanceOf(RateLimitError);
    const rle = err as RateLimitError;
    expect(rle.retryAfterMs).toBe(5000);
    expect(rle.retryable).toBe(true);
  });

  it('maps 500 to ServerError', () => {
    const err = parseHttpError(500, { message: 'Internal error' });
    expect(err).toBeInstanceOf(ServerError);
    expect(err.retryable).toBe(true);
  });

  it('maps 503 to ServerError', () => {
    const err = parseHttpError(503, { message: 'Service unavailable' });
    expect(err).toBeInstanceOf(ServerError);
    expect(err.statusCode).toBe(503);
  });

  it('uses fallback message when body has none', () => {
    const err = parseHttpError(500, {});
    expect(err.message).toContain('500');
  });

  it('preserves error code', () => {
    const err = parseHttpError(400, { message: 'bad', code: 'INVALID_AMOUNT' });
    expect(err.code).toBe('INVALID_AMOUNT');
  });

  it('all errors extend BridgeError', () => {
    const codes = [400, 401, 403, 404, 422, 429, 500, 503];
    for (const code of codes) {
      expect(parseHttpError(code, {})).toBeInstanceOf(BridgeError);
    }
  });
});

// ─── Type guards ──────────────────────────────────────────────────────────────

describe('type guard helpers', () => {
  it('isBridgeError narrows correctly', () => {
    expect(isBridgeError(new BridgeError('x'))).toBe(true);
    expect(isBridgeError(new Error('x'))).toBe(false);
    expect(isBridgeError(null)).toBe(false);
  });

  it('isAuthError narrows correctly', () => {
    expect(isAuthError(new AuthError())).toBe(true);
    expect(isAuthError(new ServerError('x'))).toBe(false);
  });

  it('isValidationError narrows correctly', () => {
    expect(isValidationError(new ValidationError('x'))).toBe(true);
    expect(isValidationError(new AuthError())).toBe(false);
  });

  it('isRateLimitError narrows correctly', () => {
    expect(isRateLimitError(new RateLimitError())).toBe(true);
    expect(isRateLimitError(new NotFoundError())).toBe(false);
  });

  it('isServerError narrows correctly', () => {
    expect(isServerError(new ServerError('x'))).toBe(true);
    expect(isServerError(new ValidationError('x'))).toBe(false);
  });

  it('isNetworkError narrows correctly', () => {
    expect(isNetworkError(new NetworkError())).toBe(true);
    expect(isNetworkError(new ServerError('x'))).toBe(false);
  });

  it('isTimeoutError narrows correctly', () => {
    expect(isTimeoutError(new TimeoutError('op', 5000))).toBe(true);
    expect(isTimeoutError(new NetworkError())).toBe(false);
  });

  it('isNotFoundError narrows correctly', () => {
    expect(isNotFoundError(new NotFoundError())).toBe(true);
    expect(isNotFoundError(new AuthError())).toBe(false);
  });
});

// ─── BridgeError.isRetryable static helper ────────────────────────────────────

describe('BridgeError.isRetryable', () => {
  it('returns true for retryable errors', () => {
    expect(BridgeError.isRetryable(new ServerError('x'))).toBe(true);
    expect(BridgeError.isRetryable(new RateLimitError())).toBe(true);
  });

  it('returns false for non-retryable errors', () => {
    expect(BridgeError.isRetryable(new AuthError())).toBe(false);
    expect(BridgeError.isRetryable(new ValidationError('x'))).toBe(false);
  });

  it('returns false for non-BridgeError values', () => {
    expect(BridgeError.isRetryable(new Error('x'))).toBe(false);
    expect(BridgeError.isRetryable(null)).toBe(false);
  });
});

// ─── Error cause chain ────────────────────────────────────────────────────────

describe('error cause chain', () => {
  it('NetworkError carries the original cause', () => {
    const original = new TypeError('fetch failed');
    const err = new NetworkError('Network error', { cause: original });
    expect((err as Error & { cause: unknown }).cause).toBe(original);
  });
});

// ─── BridgeClient typed errors ────────────────────────────────────────────────

describe('BridgeClient emits typed errors from HTTP responses', () => {
  let client: BridgeClient;

  beforeEach(() => {
    client = new BridgeClient({ baseUrl: 'http://localhost:3001' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockFetch(status: number, body: object): void {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status,
      statusText: 'Error',
      json: () => Promise.resolve(body),
    }));
  }

  it('throws AuthError on 401', async () => {
    mockFetch(401, { message: 'Unauthorized' });
    await expect(client.getQuote({ sourceAsset: 'XLM', amount: '100', targetAddress: 'C' + 'A'.repeat(55) }))
      .rejects.toSatisfy(isAuthError);
  });

  it('throws ValidationError on 400', async () => {
    mockFetch(400, { message: 'Invalid amount' });
    await expect(client.getQuote({ sourceAsset: 'XLM', amount: '-1', targetAddress: 'C' + 'A'.repeat(55) }))
      .rejects.toSatisfy(isValidationError);
  });

  it('throws RateLimitError on 429', async () => {
    mockFetch(429, { message: 'Too many requests' });
    await expect(client.health())
      .rejects.toSatisfy(isRateLimitError);
  });

  it('throws NotFoundError on 404', async () => {
    mockFetch(404, { message: 'Not found' });
    await expect(client.getStatus('deadbeef'))
      .rejects.toSatisfy(isNotFoundError);
  });

  it('throws ServerError on 500', async () => {
    mockFetch(500, { message: 'Internal server error' });
    await expect(client.health())
      .rejects.toSatisfy(isServerError);
  });

  it('throws NetworkError on fetch TypeError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(client.health())
      .rejects.toSatisfy(isNetworkError);
  });
});

// ─── Request signing headers ──────────────────────────────────────────────────

describe('BridgeClient request signing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('includes signing headers when signing is enabled', async () => {
    const capturedHeaders: Record<string, string>[] = [];

    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: unknown, init: RequestInit) => {
      capturedHeaders.push(init.headers as Record<string, string>);
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ status: 'ok' }),
      });
    }));

    const client = new BridgeClient({
      baseUrl: 'http://localhost:3001',
      apiKey: 'my-secret-key',
      signing: { enabled: true },
    });

    await client.health();

    expect(capturedHeaders.length).toBeGreaterThan(0);
    const headers = capturedHeaders[0];
    expect(headers).toHaveProperty('X-Signature');
    expect(headers).toHaveProperty('X-Timestamp');
    expect(headers).toHaveProperty('X-Nonce');
    expect(headers['X-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(Number(headers['X-Timestamp'])).toBeGreaterThan(0);
  });

  it('does not include signing headers when signing is disabled', async () => {
    const capturedHeaders: Record<string, string>[] = [];

    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: unknown, init: RequestInit) => {
      capturedHeaders.push(init.headers as Record<string, string>);
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ status: 'ok' }),
      });
    }));

    const client = new BridgeClient({
      baseUrl: 'http://localhost:3001',
      apiKey: 'my-secret-key',
      signing: { enabled: false },
    });

    await client.health();

    const headers = capturedHeaders[0];
    expect(headers).not.toHaveProperty('X-Signature');
    expect(headers).not.toHaveProperty('X-Timestamp');
    expect(headers).not.toHaveProperty('X-Nonce');
  });

  it('does not include signing headers when no apiKey', async () => {
    const capturedHeaders: Record<string, string>[] = [];

    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: unknown, init: RequestInit) => {
      capturedHeaders.push(init.headers as Record<string, string>);
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ status: 'ok' }),
      });
    }));

    const client = new BridgeClient({
      baseUrl: 'http://localhost:3001',
      signing: { enabled: true },
    });

    await client.health();

    const headers = capturedHeaders[0];
    expect(headers).not.toHaveProperty('X-Signature');
  });

  it('each signed request uses a unique nonce', async () => {
    const capturedHeaders: Record<string, string>[] = [];

    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: unknown, init: RequestInit) => {
      capturedHeaders.push({ ...(init.headers as Record<string, string>) });
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ status: 'ok' }),
      });
    }));

    const signingConfig = { baseUrl: 'http://localhost:3001', apiKey: 'my-secret-key', signing: { enabled: true } } as const;

    // Use separate client instances to avoid the health-response cache
    const client1 = new BridgeClient(signingConfig);
    const client2 = new BridgeClient(signingConfig);

    await client1.health();
    await client2.health();

    expect(capturedHeaders).toHaveLength(2);
    expect(capturedHeaders[0]['X-Nonce']).not.toBe(capturedHeaders[1]['X-Nonce']);
  });

  it('still sends X-API-Key alongside signing headers', async () => {
    const capturedHeaders: Record<string, string>[] = [];

    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: unknown, init: RequestInit) => {
      capturedHeaders.push(init.headers as Record<string, string>);
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ status: 'ok' }),
      });
    }));

    const client = new BridgeClient({
      baseUrl: 'http://localhost:3001',
      apiKey: 'my-secret-key',
      signing: { enabled: true },
    });

    await client.health();

    const headers = capturedHeaders[0];
    expect(headers['X-API-Key']).toBe('my-secret-key');
    expect(headers['X-Signature']).toBeDefined();
  });
});
