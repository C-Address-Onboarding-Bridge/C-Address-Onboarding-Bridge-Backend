import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Request, Response } from 'express';
import { ZodError, z } from 'zod';

process.env.NODE_ENV = 'test';

vi.mock('../logger', () => {
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return { logger: mockLogger };
});

import { errorHandler, AppError } from '../middleware/error';
import { xssErrorSanitizer } from '../middleware/security';

function makeReq(): Request {
  return {} as Request;
}

function makeRes(): { res: Response; statusMock: ReturnType<typeof vi.fn>; jsonMock: ReturnType<typeof vi.fn> } {
  const jsonMock = vi.fn().mockReturnThis();
  const statusMock = vi.fn().mockReturnThis();
  const res = {
    json: jsonMock,
    status: statusMock,
  } as unknown as Response;
  return { res, statusMock, jsonMock };
}

describe('errorHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('handles AppError with appropriate status code', () => {
    const req = makeReq();
    const { res, statusMock, jsonMock } = makeRes();
    const err = new AppError(404, 'Not found');

    errorHandler(err, req, res, vi.fn() as never);

    expect(statusMock).toHaveBeenCalledWith(404);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'Not found' })
    );
  });

  it('handles ZodError with 400 status', () => {
    const req = makeReq();
    const { res, statusMock, jsonMock } = makeRes();

    const schema = z.object({ name: z.string() });
    let err: Error | null = null;
    try {
      schema.parse({});
    } catch (e) {
      err = e as Error;
    }

    if (err && err instanceof ZodError) {
      errorHandler(err, req, res, vi.fn() as never);
      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'validation_error' })
      );
    }
  });

  it('handles unexpected errors with 500 status', () => {
    const req = makeReq();
    const { res, statusMock, jsonMock } = makeRes();
    const err = new Error('Something went wrong');

    errorHandler(err, req, res, vi.fn() as never);

    expect(statusMock).toHaveBeenCalledWith(500);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'internal_server_error' })
    );
  });

  it('logs errors appropriately', async () => {
    const { logger } = await import('../logger');
    const req = makeReq();
    const { res } = makeRes();
    const err = new AppError(400, 'Bad request');

    errorHandler(err, req, res, vi.fn() as never);

    expect(vi.mocked(logger.error)).toHaveBeenCalled();
  });
});

describe('xssErrorSanitizer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sanitizes the error and forwards it via next instead of responding', () => {
    const req = makeReq();
    const { res, statusMock, jsonMock } = makeRes();
    const next = vi.fn();
    const err = new Error('<script>alert(1)</script>boom');

    xssErrorSanitizer(err, req, res, next as never);

    expect(statusMock).not.toHaveBeenCalled();
    expect(jsonMock).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    const forwarded = next.mock.calls[0][0] as Error;
    expect(forwarded).toBeInstanceOf(Error);
    expect(forwarded.message).not.toContain('<script>');
  });

  it('forwards ZodError unchanged so errorHandler can map it to 400 validation_error', () => {
    const req = makeReq();
    const { res, statusMock, jsonMock } = makeRes();
    const next = vi.fn();

    const schema = z.object({ name: z.string() });
    let err: Error | null = null;
    try {
      schema.parse({});
    } catch (e) {
      err = e as Error;
    }

    expect(err).toBeInstanceOf(ZodError);
    xssErrorSanitizer(err as Error, req, res, next as never);

    expect(statusMock).not.toHaveBeenCalled();
    expect(jsonMock).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0]).toBe(err);
  });
});
