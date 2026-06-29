import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';
import type { Request, Response } from 'express';

process.env.NODE_ENV = 'test';

vi.mock('../index', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  registerWebhookVerifier,
  moonpayVerifier,
  transakVerifier,
  verifyMoonpayWebhook,
  verifyTransakWebhook,
} from '../middleware/webhookVerification';

const MOONPAY_SECRET = 'test-moonpay-secret';
const TRANSAK_SECRET = 'test-transak-secret';

beforeEach(() => {
  registerWebhookVerifier('moonpay', moonpayVerifier, MOONPAY_SECRET);
  registerWebhookVerifier('transak', transakVerifier, TRANSAK_SECRET);
});

function makeMoonpaySignature(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('base64');
}

function makeTransakSignature(payload: string, secret: string): string {
  const hex = crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
  return `sha256=${hex}`;
}

function mockReq(overrides: Partial<Request> = {}): Request {
  return {
    ip: '127.0.0.1',
    path: '/api/webhook/test',
    body: '{}',
    headers: {},
    ...overrides,
  } as unknown as Request;
}

function mockRes(): { res: Response; status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  return { res: { status, json } as unknown as Response, status, json };
}

describe('moonpay webhook verifier', () => {
  it('passes request with valid HMAC-SHA256 base64 signature', () => {
    const payload = JSON.stringify({ type: 'payment', amount: '100' });
    const sig = makeMoonpaySignature(payload, MOONPAY_SECRET);
    const req = mockReq({ body: payload, headers: { 'x-moonpay-signature': sig } });
    const { res } = mockRes();
    const next = vi.fn();

    verifyMoonpayWebhook(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('rejects request with wrong signature', () => {
    const payload = '{"type":"payment"}';
    const req = mockReq({ body: payload, headers: { 'x-moonpay-signature': 'wrong-sig-value-abc' } });
    const { res, status, json } = mockRes();
    const next = vi.fn();

    verifyMoonpayWebhook(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: 'unauthorized' }));
  });

  it('rejects request with missing signature header', () => {
    const req = mockReq({ body: '{}', headers: {} });
    const { res, status } = mockRes();
    const next = vi.fn();

    verifyMoonpayWebhook(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
  });
});

describe('transak webhook verifier', () => {
  it('passes request with valid sha256=hex signature', () => {
    const payload = JSON.stringify({ eventId: 'abc', status: 'completed' });
    const sig = makeTransakSignature(payload, TRANSAK_SECRET);
    const req = mockReq({ body: payload, headers: { 'x-webhook-signature': sig } });
    const { res } = mockRes();
    const next = vi.fn();

    verifyTransakWebhook(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('rejects invalid transak signature', () => {
    const payload = '{"eventId":"xyz"}';
    const req = mockReq({ body: payload, headers: { 'x-webhook-signature': 'sha256=badhexvalue' } });
    const { res, status } = mockRes();
    const next = vi.fn();

    verifyTransakWebhook(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
  });

  it('rejects missing transak signature header', () => {
    const req = mockReq({ body: '{}', headers: {} });
    const { res, status } = mockRes();
    const next = vi.fn();

    verifyTransakWebhook(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
  });
});

describe('timestamp validation', () => {
  it('rejects payload with timestamp older than 5 minutes', () => {
    const staleTs = Date.now() - 6 * 60 * 1000;
    const payload = JSON.stringify({ type: 'payment', webhookTimestamp: staleTs });
    const sig = makeMoonpaySignature(payload, MOONPAY_SECRET);
    const req = mockReq({ body: payload, headers: { 'x-moonpay-signature': sig } });
    const { res, status } = mockRes();
    const next = vi.fn();

    verifyMoonpayWebhook(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
  });

  it('accepts payload with recent timestamp', () => {
    const payload = JSON.stringify({ type: 'payment', webhookTimestamp: Date.now() });
    const sig = makeMoonpaySignature(payload, MOONPAY_SECRET);
    const req = mockReq({ body: payload, headers: { 'x-moonpay-signature': sig } });
    const { res } = mockRes();
    const next = vi.fn();

    verifyMoonpayWebhook(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });
});

describe('replay attack prevention', () => {
  it('rejects a duplicate signature (replay)', () => {
    // First call: valid but use a unique fresh sig
    const freshPayload = JSON.stringify({ type: 'replay-test-fresh-' + Math.random() });
    const freshSig = makeMoonpaySignature(freshPayload, MOONPAY_SECRET);

    const req1 = mockReq({ body: freshPayload, headers: { 'x-moonpay-signature': freshSig } });
    const { res: res1 } = mockRes();
    const next1 = vi.fn();
    verifyMoonpayWebhook(req1, res1, next1);
    expect(next1).toHaveBeenCalledOnce();

    // Second call: same sig → replay rejected
    const req2 = mockReq({ body: freshPayload, headers: { 'x-moonpay-signature': freshSig } });
    const { res: res2, status: status2 } = mockRes();
    const next2 = vi.fn();
    verifyMoonpayWebhook(req2, res2, next2);
    expect(next2).not.toHaveBeenCalled();
    expect(status2).toHaveBeenCalledWith(401);
  });
});

describe('rate limiting failed attempts', () => {
  it('returns 429 after exceeding failure threshold from same IP', () => {
    const attackerIp = '10.0.0.' + Math.floor(Math.random() * 200 + 50);
    const next = vi.fn();

    for (let i = 0; i < 11; i++) {
      const req = mockReq({ ip: attackerIp, body: '{}', headers: { 'x-moonpay-signature': 'bad-sig-' + i } });
      const { res, status } = mockRes();
      verifyMoonpayWebhook(req, res, next);
      if (i === 10) {
        expect(status).toHaveBeenCalledWith(429);
      }
    }
  });
});
