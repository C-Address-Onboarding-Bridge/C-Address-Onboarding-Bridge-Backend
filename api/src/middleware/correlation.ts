import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import pino from 'pino';
import { logger } from '../index';

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      correlationId: string;
      log: pino.Logger;
    }
  }
}

export function correlationMiddleware(req: Request, res: Response, next: NextFunction): void {
  const requestId = (req.headers['x-request-id'] as string) || randomUUID();
  const correlationId = (req.headers['x-correlation-id'] as string) || requestId;

  req.requestId = requestId;
  req.correlationId = correlationId;
  req.log = logger.child({ requestId, correlationId });

  res.setHeader('X-Request-ID', requestId);
  res.setHeader('X-Correlation-ID', correlationId);

  const start = Date.now();

  res.on('finish', () => {
    req.log.info({
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration_ms: Date.now() - start,
    }, 'request completed');
  });

  req.log.info({ method: req.method, path: req.path }, 'request received');
  next();
}
