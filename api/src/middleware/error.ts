import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { logger } from '../logger';
import { XdrValidationError } from '../services/xdrValidator';

/**
 * Application-level error with an explicit HTTP status code.
 * Throw this from route handlers to produce a structured JSON error response.
 */
export class AppError extends Error {
  public statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
  }
}

/**
 * Express error-handling middleware. Must be registered last.
 * Handles `ZodError` (validation), `AppError` (known errors), and unexpected errors.
 *
 * TODO: replace `console.error` with the shared pino logger once the logger is
 * extracted from `index.ts` into a standalone module (avoids circular import).
 */
export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction,
) {
  if (err instanceof ZodError) {
    logger.error({ err, message: 'Validation error' });
    res.status(400).json({
      error: 'validation_error',
      details: err.errors,
    });
    return;
  }

  if (err instanceof XdrValidationError) {
    logger.warn({ code: err.code, detail: err.detail }, 'XDR validation error');
    res.status(400).json({
      error: err.code,
      message: err.detail,
    });
    return;
  }

  if ((err as any).type === 'entity.too.large' || (err as any).status === 413) {
    logger.warn({ err }, 'Payload too large');
    res.status(413).json({
      error: 'XDR_TOO_LARGE',
      message: 'Request payload exceeds maximum allowed size',
    });
    return;
  }

  if (err instanceof AppError) {
    logger.error({ err, message: err.message });
    res.status(err.statusCode).json({
      error: err.message,
    });
    return;
  }

  logger.error({ err, message: 'Unexpected error' });
  res.status(500).json({
    error: 'internal_server_error',
  });
}
