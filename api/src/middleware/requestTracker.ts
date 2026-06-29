import { Request, Response, NextFunction } from 'express';
import { gracefulShutdown } from '../shutdown';

export function requestTracker(req: Request, res: Response, next: NextFunction): void {
  if (gracefulShutdown.shuttingDown) {
    res.set('Connection', 'close');
    res.status(503).json({ error: 'service_unavailable', message: 'server is shutting down' });
    return;
  }

  gracefulShutdown.increment();

  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      gracefulShutdown.decrement();
    }
  };

  res.on('finish', release);
  res.on('close', release);

  next();
}
