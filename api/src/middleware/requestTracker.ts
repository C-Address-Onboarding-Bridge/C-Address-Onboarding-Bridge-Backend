import { Request, Response, NextFunction } from 'express';
import { gracefulShutdown } from '../shutdown';

export function requestTracker(req: Request, res: Response, next: NextFunction): void {
  throw new Error('Not implemented: requestTracker');
}
