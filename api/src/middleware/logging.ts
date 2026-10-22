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
  if (depth > 5 || body === null || body === undefined) return body;
  if (typeof body !== 'object') return body;
  if (Array.isArray(body)) return body.map((item) => maskBody(item, depth + 1));

  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(body as Record<string, unknown>)) {
    if (sensitiveBodyFields.has(key)) {
      const str = typeof val === 'string' ? val : JSON.stringify(val) ?? '';
      result[key] = maskValue(str);
    } else {
      result[key] = maskBody(val, depth + 1);
    }
  }
  return result;
}

function truncate(body: unknown): string {
  const str = JSON.stringify(body);
  const limit = config.logging.bodyTruncateLength;
  return str.length > limit ? `${str.slice(0, limit)}...[truncated]` : str;
}

export function loggingMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  const reqId = Math.random().toString(36).slice(2, 10);

  res.on('finish', () => {
    const logger = req.app.get('logger');
    if (!logger) return;
    const durationMs = Date.now() - start;

    if (logger.level === 'debug') {
      logger.debug({
        reqId,
        method: req.method,
        path: req.path,
        query: req.query,
        headers: maskHeaders(req.headers as Record<string, string | string[] | undefined>),
        body: maskBody(req.body),
        status: res.statusCode,
        durationMs,
        ip: req.ip,
      }, 'request completed');
    } else {
      logger.info({
        reqId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs,
        ip: req.ip,
        body: req.body !== undefined ? truncate(maskBody(req.body)) : undefined,
      }, 'request completed');
    }
  });

  next();
}
