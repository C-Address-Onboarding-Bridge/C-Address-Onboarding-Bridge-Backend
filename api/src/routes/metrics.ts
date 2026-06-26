import { Router, Request, Response } from 'express';
import { register } from '../services/metrics';

export const metricsRouter = Router();

metricsRouter.get('/', async (_req: Request, res: Response) => {
  try {
    const output = await register.metrics();
    res.set('Content-Type', register.contentType).send(output);
  } catch {
    res.status(500).json({ error: 'metrics_unavailable' });
  }
});
