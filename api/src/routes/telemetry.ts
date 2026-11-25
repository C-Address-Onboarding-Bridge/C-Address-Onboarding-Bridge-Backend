import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { telemetryEventCounter } from '../services/metrics';

export const telemetryRouter = Router();

const MAX_BATCH_SIZE = 100;

const telemetryEventSchema = z.object({
  sdkVersion: z.string().min(1),
  nodeVersion: z.string().min(1),
  platform: z.string().min(1),
  method: z.string().min(1),
  responseTimeMs: z.number().nonnegative(),
  errorType: z.string().optional(),
});

const telemetryBodySchema = z.union([
  telemetryEventSchema,
  z.array(telemetryEventSchema).min(1).max(MAX_BATCH_SIZE),
]);

// Served at the router mount point (`/api/telemetry`), not `/api/telemetry/telemetry`.
telemetryRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = telemetryBodySchema.parse(req.body);
    const events = Array.isArray(body) ? body : [body];

    for (const event of events) {
      telemetryEventCounter.inc({
        method: event.method,
        sdkVersion: event.sdkVersion,
        errorType: event.errorType ?? 'none',
      });
    }

    res.status(202).json({ accepted: true });
  } catch (err) {
    next(err);
  }
});
