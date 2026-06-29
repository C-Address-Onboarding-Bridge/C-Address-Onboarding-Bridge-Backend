import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';

/**
 * Application-level error with an explicit HTTP status code.
 * Throw this from route handlers to produce a structured JSON error response.
 */
export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
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
    res.status(400).json({
      error: 'validation_error',
      details: err.errors.map((e) => ({
        path: e.path.join('.'),
        message: e.message,
      })),
    });
    return;
  }

  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: 'request_error',
      message: err.message,
    });
    return;
  }

  console.error('unhandled error:', err);
  res.status(500).json({
    error: 'internal_error',
    message: 'an unexpected error occurred',
  });
}
