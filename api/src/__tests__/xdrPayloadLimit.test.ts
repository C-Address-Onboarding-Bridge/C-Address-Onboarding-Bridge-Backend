import { describe, it, expect } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { errorHandler } from '../middleware/error';
import { MAX_XDR_BYTE_LENGTH, validateXdr } from '../services/xdrValidator';

process.env.NODE_ENV = 'test';

describe('XDR and body parser limits alignment (#689)', () => {
  it('allows bodies larger than 32KB up to MAX_XDR_BYTE_LENGTH (64KB)', async () => {
    const app = express();
    // Using configured index.ts:148 limit of '128kb'
    app.use('/api', express.json({ limit: '128kb' }));
    app.post('/api/test-xdr', (req: Request, res: Response) => {
      res.json({ receivedLength: req.body.signedXdr?.length });
    });
    app.use(errorHandler);

    // 48 KB payload (previously rejected by 32kb limit, now allowed within 64KB MAX_XDR_BYTE_LENGTH)
    const payload = 'A'.repeat(48 * 1024);
    const res = await request(app)
      .post('/api/test-xdr')
      .send({ signedXdr: payload });

    expect(res.status).toBe(200);
    expect(res.body.receivedLength).toBe(48 * 1024);
  });

  it('returns structured XDR_TOO_LARGE error when XDR exceeds MAX_XDR_BYTE_LENGTH', async () => {
    const app = express();
    app.use('/api', express.json({ limit: '128kb' }));
    app.post('/api/test-xdr', (req: Request, res: Response, next: NextFunction) => {
      try {
        validateXdr(req.body.signedXdr);
        res.json({ ok: true });
      } catch (err) {
        next(err);
      }
    });
    app.use(errorHandler);

    // 65 KB payload (exceeds MAX_XDR_BYTE_LENGTH = 64 KB)
    const payload = 'A'.repeat(MAX_XDR_BYTE_LENGTH + 1024);
    const res = await request(app)
      .post('/api/test-xdr')
      .send({ signedXdr: payload });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('XDR_TOO_LARGE');
    expect(res.body.message).toContain('exceeds limit of 65536 bytes');
  });

  it('returns structured 413 error if payload exceeds maximum JSON body limit', async () => {
    const app = express();
    app.use('/api', express.json({ limit: '128kb' }));
    app.post('/api/test-xdr', (req: Request, res: Response) => {
      res.json({ ok: true });
    });
    app.use(errorHandler);

    // 130 KB payload (exceeds 128kb body parser limit)
    const payload = 'A'.repeat(130 * 1024);
    const res = await request(app)
      .post('/api/test-xdr')
      .send({ signedXdr: payload });

    expect(res.status).toBe(413);
    expect(res.body.error).toBe('XDR_TOO_LARGE');
    expect(res.body.message).toBe('Request payload exceeds maximum allowed size');
  });
});
