import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import pino from 'pino';
import { trace, context } from '@opentelemetry/api';
import { logger } from '../logger';

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
  req.requestId = (req.headers['x-request-id'] as string) || randomUUID();
  req.correlationId = (req.headers['x-correlation-id'] as string) || req.requestId;
  res.setHeader('X-Correlation-ID', req.correlationId);
  req.log = logger.child({ requestId: req.requestId, correlationId: req.correlationId });
  next();
}
