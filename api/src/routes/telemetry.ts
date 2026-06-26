import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';

export const telemetryRouter = Router();

const telemetrySchema = z.object({
  sdkVersion: z.string().min(1),
  nodeVersion: z.string().min(1),
  platform: z.string().min(1),
  method: z.string().min(1),
  responseTimeMs: z.number().int().nonnegative(),
  errorType: z.string().optional(),
});

telemetryRouter.post('/telemetry', async (req: Request, res: Response, next: NextFunction) => {
  try {
    telemetrySchema.parse(req.body);
    res.status(202).json({ accepted: true });
  } catch (err) {
    next(err);
  }
});
