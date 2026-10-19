import { NextFunction, Router, Request, Response } from 'express';
import { rbacAuth, requireScopes } from '../middleware/rbacAuth';
import { register } from '../services/metrics';

export const metricsRouter = Router();

export function metricsAuth(req: Request, res: Response, next: NextFunction): void {
  const authorization = req.headers.authorization;
  const bearer = typeof authorization === 'string' ? /^Bearer\s+(\S+)$/i.exec(authorization) : null;
  if (!req.headers['x-api-key'] && bearer) {
    req.headers['x-api-key'] = bearer[1];
  }

  rbacAuth(req, res, () => requireScopes('metrics:read')(req, res, next));
}

metricsRouter.get('/', async (_req: Request, res: Response) => {
  try {
    const output = await register.metrics();
    res.set('Content-Type', register.contentType).send(output);
  } catch {
    res.status(500).json({ error: 'metrics_unavailable' });
  }
});
