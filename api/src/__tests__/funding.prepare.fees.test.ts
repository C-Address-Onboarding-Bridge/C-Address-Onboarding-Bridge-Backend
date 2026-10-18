import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

vi.mock('../services/funding', () => ({
  fundingService: {
    prepareFunding: vi.fn().mockResolvedValue({ id: 'prep_1', amount: '10', asset: 'XLM' }),
    prepareBatch: vi.fn().mockResolvedValue([{ id: 'prep_1' }]),
    getStatus: vi.fn().mockResolvedValue({ paused: false }),
  },
}));

vi.mock('../services/quote', () => ({
  quoteService: {
    getQuote: vi.fn().mockResolvedValue({ from: 'XLM', to: 'USDC', amount: '10', rate: '1' }),
  },
}));

import express from 'express';
import { fundingRouter } from '../routes/funding';
import { quoteRouter } from '../routes/quote';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/fund', fundingRouter);
  app.use('/quote', quoteRouter);
  return app;
}

describe('route module loading (#797)', () => {
  let app: express.Express;

  beforeEach(() => {
    app = buildApp();
  });

  it('imports fundingRouter and serves GET /fund without a 500', async () => {
    const res = await request(app).get('/fund');
    expect(res.status).toBeLessThan(500);
  });

  it('imports quoteRouter and serves GET /quote without a 500', async () => {
    const res = await request(app).get('/quote').query({ from: 'XLM', to: 'USDC', amount: '10' });
    expect(res.status).toBeLessThan(500);
  });
});
