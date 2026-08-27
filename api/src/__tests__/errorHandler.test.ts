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
