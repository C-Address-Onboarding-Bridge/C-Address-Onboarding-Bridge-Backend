import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';

process.env.NODE_ENV = 'test';

vi.mock('../middleware/rbacAuth', () => ({
  rbacAuth: vi.fn((_req: Request, _res: Response, next: () => void) => next()),
  requireScopes: vi.fn(() => (_req: Request, _res: Response, next: () => void) => next()),
}));

import { metricsAuth } from '../routes/metrics';
import { rbacAuth, requireScopes } from '../middleware/rbacAuth';

describe('metricsAuth', () => {
  it('maps a Bearer token to x-api-key and requires metrics:read', () => {
    const req = { headers: { authorization: 'Bearer scrape-key' } } as unknown as Request;
    const next = vi.fn();

    metricsAuth(req, {} as Response, next);

    expect(req.headers['x-api-key']).toBe('scrape-key');
    expect(rbacAuth).toHaveBeenCalled();
    expect(requireScopes).toHaveBeenCalledWith('metrics:read');
    expect(next).toHaveBeenCalled();
  });

  it('keeps an existing x-api-key header', () => {
    const req = {
      headers: { authorization: 'Bearer other', 'x-api-key': 'real-key' },
    } as unknown as Request;

    metricsAuth(req, {} as Response, vi.fn());

    expect(req.headers['x-api-key']).toBe('real-key');
  });
});
