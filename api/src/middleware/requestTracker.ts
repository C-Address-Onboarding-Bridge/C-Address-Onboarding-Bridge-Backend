import { Request, Response, NextFunction } from 'express';
import { gracefulShutdown } from '../shutdown';

export function requestTracker(req: Request, res: Response, next: NextFunction): void {
  if (gracefulShutdown.shuttingDown) {
    // Ask the client not to reuse this socket, so keep-alive connections don't
    // keep landing on a server that is on its way out.
    res.set('Connection', 'close');
    res.status(503).json({ error: 'service_unavailable', message: 'server is shutting down' });
    return;
  }

  gracefulShutdown.increment();

  // 'finish' and 'close' can both fire for a single response (a normal finish
  // is followed by close). The latch keeps the count honest — a double
  // decrement here would let shutdown() drain early and cut off live requests.
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    gracefulShutdown.decrement();
  };

  res.on('finish', release);
  res.on('close', release);

  next();
}
