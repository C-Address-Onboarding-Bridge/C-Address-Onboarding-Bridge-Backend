import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

process.env.NODE_ENV = 'test';

const { pass } = vi.hoisted(() => ({
  pass: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../services/soroban', () => ({
  sorobanService: {
    submitFundingTransaction: vi.fn().mockResolvedValue({ hash: 'h', status: 'SUCCESS' }),
    decodeRecipientsFromXdr: vi.fn().mockReturnValue(null),
  },
}));
vi.mock('../middleware/rateLimit', () => ({ fundEndpointRateLimit: pass, fundAbuseDetectionMiddleware: pass }));
vi.mock('../middleware/idempotency', () => ({ idempotencyMiddleware: pass }));
// funding.ts imports these modules, which do not exist on main yet.
vi.mock('../middleware/rbac', () => ({ requireScopes: () => pass }));
vi.mock('../types/auth', () => ({ PermissionScope: { FUND_WRITE: 'fund:write' } }));
vi.mock('../services/asyncPipeline', () => ({ enqueueAudit: vi.fn(), enqueueFundingMetrics: vi.fn() }));
vi.mock('../services/auditLog', () => ({ hashPayload: vi.fn(), integrityAuditLog: { append: vi.fn() } }));
vi.mock('../services/metrics', () => ({ recordFundingMetrics: vi.fn() }));
vi.mock('../services/explorer', () => ({ explorerService: { txUrl: vi.fn(), txUrlWithFallbacks: vi.fn() } }));

import { DEFAULT_JSON_LIMIT, FUNDING_PATHS, fundingJsonParser } from '../middleware/bodyParser';
import { fundingRouter } from '../routes/funding';
import { MAX_XDR_BYTE_LENGTH } from '../services/xdrValidator';

function buildApp() {
  const app = express();
  app.use(FUNDING_PATHS, fundingJsonParser);
  app.use('/api', express.json({ limit: DEFAULT_JSON_LIMIT }));
  app.use('/api/v1/fund', fundingRouter);
  app.post('/api/v1/other', (_req, res) => res.json({ ok: true }));
  return app;
}

// 100 recipients is the batch maximum.
const recipients = Array.from({ length: 100 }, () => ({
  target: `C${'A'.repeat(55)}`,
  amount: '1000000000000',
}));

describe('funding body size limit (#689)', () => {
  const app = buildApp();

  it('lets a max-size batch (64 KiB XDR + 100 recipients) reach validation', async () => {
    const body = { signedXdr: 'A'.repeat(MAX_XDR_BYTE_LENGTH), recipients };
    expect(JSON.stringify(body).length).toBeGreaterThan(64 * 1024);

    const res = await request(app).post('/api/v1/fund/batch').send(body);

    // Reached the route: rejected by the (mocked) XDR decoder, not the body parser.
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('xdr_decode_failed');
  });

  it('returns XDR_TOO_LARGE for a signedXdr one byte over the limit', async () => {
    const res = await request(app)
      .post('/api/v1/fund/batch')
      .send({ signedXdr: 'A'.repeat(MAX_XDR_BYTE_LENGTH + 1), recipients });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('XDR_TOO_LARGE');
  });

  it('returns XDR_TOO_LARGE on POST /fund for an oversized signedXdr', async () => {
    const res = await request(app)
      .post('/api/v1/fund')
      .send({ signedXdr: 'A'.repeat(MAX_XDR_BYTE_LENGTH + 1) });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('XDR_TOO_LARGE');
  });

  it('returns a structured XDR_TOO_LARGE when the body exceeds the funding parser limit', async () => {
    const res = await request(app)
      .post('/api/v1/fund')
      .send({ signedXdr: 'A'.repeat(200 * 1024) });

    expect(res.status).toBe(413);
    expect(res.body.error).toBe('XDR_TOO_LARGE');
  });

  it('keeps the default limit for non-funding routes', async () => {
    const res = await request(app)
      .post('/api/v1/other')
      .send({ data: 'A'.repeat(40 * 1024) });

    expect(res.status).toBe(413);
  });
});
