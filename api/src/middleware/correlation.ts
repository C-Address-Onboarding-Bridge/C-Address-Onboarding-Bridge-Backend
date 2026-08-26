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
  throw new Error('Not implemented: correlationMiddleware');
}
