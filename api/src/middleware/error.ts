import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { logger } from '../logger';

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
  throw new Error('Not implemented: errorHandler');
}
