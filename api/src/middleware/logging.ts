import { Request, Response, NextFunction } from 'express';
import { config } from '../config';

const SENSITIVE_HEADER_NAMES = new Set([
  'x-api-key', 'authorization', 'x-secret', 'cookie', 'set-cookie', 'proxy-authorization',
]);

const sensitiveBodyFields = new Set(config.logging.sensitiveFields);

export function maskValue(val: string): string {
  throw new Error('Not implemented: maskValue');
}

export function maskHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, unknown> {
  throw new Error('Not implemented: maskHeaders');
}

export function maskBody(body: unknown, depth = 0): unknown {
  throw new Error('Not implemented: maskBody');
}

function truncate(body: unknown): string {
  const str = JSON.stringify(body);
  const limit = config.logging.bodyTruncateLength;
  return str.length > limit ? `${str.slice(0, limit)}...[truncated]` : str;
}

export function loggingMiddleware(req: Request, res: Response, next: NextFunction): void {
  throw new Error('Not implemented: loggingMiddleware');
}
