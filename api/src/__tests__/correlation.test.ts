import { describe, it, expect, vi } from 'vitest';
import { Request, Response } from 'express';

process.env.NODE_ENV = 'test';

vi.mock('../index', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnValue({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  },
}));

import { correlationMiddleware } from '../middleware/correlation';

function makeReq(headers: Record<string, string> = {}): Request {
  return { headers, on: vi.fn() } as unknown as Request;
}

function makeRes(): Response {
  return {
    setHeader: vi.fn(),
    on: vi.fn(),
  } as unknown as Response;
}

describe('correlationMiddleware', () => {
  it('assigns a generated requestId if none provided', () => {
    const req = makeReq();
    const res = makeRes();
    const next = vi.fn();

    correlationMiddleware(req, res, next as never);

    expect(req.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(next).toHaveBeenCalledOnce();
  });

  it('uses provided X-Request-ID header', () => {
    const req = makeReq({ 'x-request-id': 'my-request-id' });
    const res = makeRes();
    correlationMiddleware(req, res, vi.fn() as never);
    expect(req.requestId).toBe('my-request-id');
  });

  it('uses provided X-Correlation-ID and sets it on response', () => {
    const req = makeReq({ 'x-correlation-id': 'corr-123' });
    const res = makeRes();
    correlationMiddleware(req, res, vi.fn() as never);
    expect(req.correlationId).toBe('corr-123');
    expect(res.setHeader).toHaveBeenCalledWith('X-Correlation-ID', 'corr-123');
  });

  it('falls back correlationId to requestId when not provided', () => {
    const req = makeReq();
    const res = makeRes();
    correlationMiddleware(req, res, vi.fn() as never);
    expect(req.correlationId).toBe(req.requestId);
  });

  it('attaches a child logger to the request', () => {
    const req = makeReq();
    const res = makeRes();
    correlationMiddleware(req, res, vi.fn() as never);
    expect(req.log).toBeDefined();
    expect(typeof req.log.info).toBe('function');
  });
});
