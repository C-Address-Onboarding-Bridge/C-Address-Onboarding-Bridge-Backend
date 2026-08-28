import { Request, Response, NextFunction } from 'express';
import { config } from '../config';

const SENSITIVE_HEADER_NAMES = new Set([
  'x-api-key', 'authorization', 'x-secret', 'cookie', 'set-cookie', 'proxy-authorization',
]);

const sensitiveBodyFields = new Set(config.logging.sensitiveFields);

export function maskValue(val: string): string {
  // Values of 4 chars or fewer are masked whole: keeping a 4-char suffix of a
  // 4-char secret would leak the entire value.
  if (val.length <= 4) return '***';
  return `***${val.slice(-4)}`;
}

export function maskHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) {
      result[name] = undefined;
      continue;
    }
    if (SENSITIVE_HEADER_NAMES.has(name.toLowerCase())) {
      if (Array.isArray(value)) {
        result[name] = value.map((v) => maskValue(v));
      } else {
        result[name] = maskValue(value);
      }
    } else {
      result[name] = value;
    }
  }
  return result;
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
