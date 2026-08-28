import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';

process.env.NODE_ENV = 'test';

vi.mock('../index', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  injectionProtection,
  parameterPollutionProtection,
  contentTypeEnforcement,
  requestSizeLimiting,
  sanitizeErrorMessage,
} from '../middleware/security';

function mockReq(overrides: Partial<Request> = {}): Request {
  return {
    method: 'POST',
    path: '/api/v1/test',
    ip: '127.0.0.1',
    body: {},
    query: {},
    params: {},
    headers: { 'content-type': 'application/json', 'content-length': '10' },
    ...overrides,
  } as unknown as Request;
}

function mockRes(): { res: Response; status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const res = { status, json } as unknown as Response;
  return { res, status, json }; // json exposed for assertion in callers that need it
}

describe('injectionProtection middleware', () => {
  it('passes clean requests through', () => {
    const req = mockReq({ body: { amount: '1000', address: 'GABCDE' } });
    const { res } = mockRes();
    const next = vi.fn();

    injectionProtection(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('blocks SQL injection in body', () => {
    const req = mockReq({ body: { input: "1' OR '1'='1" } });
    const { res, status, json } = mockRes();
    const next = vi.fn();

    injectionProtection(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: 'invalid_input' }));
  });

  it('blocks SELECT statement in query params', () => {
    const req = mockReq({ query: { search: 'SELECT * FROM users' } });
    const { res, status } = mockRes();
    const next = vi.fn();

    injectionProtection(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(400);
  });

  it('blocks DROP TABLE pattern', () => {
    const req = mockReq({ body: { name: 'test; DROP TABLE users;--' } });
    const { res, status } = mockRes();
    const next = vi.fn();

    injectionProtection(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(400);
  });

  it('blocks NoSQL $where operator', () => {
    const req = mockReq({ body: { filter: { $where: 'this.balance > 0' } } });
    const { res, status } = mockRes();
    const next = vi.fn();

    injectionProtection(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(400);
  });

  it('blocks NoSQL $ne operator', () => {
    const req = mockReq({ body: { status: { $ne: null } } });
    const { res, status } = mockRes();
    const next = vi.fn();

    injectionProtection(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(400);
  });

  it('blocks XSS script tag', () => {
    const req = mockReq({ body: { memo: '<script>alert(1)</script>' } });
    const { res, status } = mockRes();
    const next = vi.fn();

    injectionProtection(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(400);
  });

  it('blocks javascript: URI', () => {
    const req = mockReq({ body: { url: 'javascript:alert(document.cookie)' } });
    const { res, status } = mockRes();
    const next = vi.fn();

    injectionProtection(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(400);
  });

  it('allows normal Stellar address strings', () => {
    const req = mockReq({ body: { address: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW' } });
    const { res } = mockRes();
    const next = vi.fn();

    injectionProtection(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('allows memo with semicolon', () => {
    const req = mockReq({ body: { memo: 'Invoice 12; thanks for payment' } });
    const { res } = mockRes();
    const next = vi.fn();

    injectionProtection(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('allows memo with double hyphens', () => {
    const req = mockReq({ body: { memo: 'Rent -- March 2024' } });
    const { res } = mockRes();
    const next = vi.fn();

    injectionProtection(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('allows memo with multiple punctuation marks', () => {
    const req = mockReq({ body: { memo: 'Payment for Q1; see invoice #42 -- urgent!' } });
    const { res } = mockRes();
    const next = vi.fn();

    injectionProtection(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('blocks SQL injection in non-memo fields', () => {
    const req = mockReq({ body: { name: 'test; DROP TABLE users;--', memo: 'Notes; see invoice' } });
    const { res, status, json } = mockRes();
    const next = vi.fn();

    injectionProtection(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: 'invalid_input' }));
  });

  it('identifies rejected field in error message', () => {
    const req = mockReq({ body: { description: 'Normal text', injected: "1' OR '1'='1" } });
    const { res, json } = mockRes();
    const next = vi.fn();

    injectionProtection(req, res, next);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'invalid_input',
        message: expect.stringContaining('injected'),
      })
    );
  });
});

describe('parameterPollutionProtection middleware', () => {
  it('passes requests without duplicate query params', () => {
    const req = mockReq({ query: { sourceAsset: 'XLM', amount: '1000' } });
    const { res } = mockRes();
    const next = vi.fn();

    parameterPollutionProtection(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('blocks duplicate query parameters (array values)', () => {
    const req = mockReq({ query: { amount: ['100', '200'] as unknown as string } });
    const { res, status, json } = mockRes();
    const next = vi.fn();

    parameterPollutionProtection(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: 'invalid_input' }));
  });
});

describe('contentTypeEnforcement middleware', () => {
  it('allows POST with application/json', () => {
    const req = mockReq({ method: 'POST', headers: { 'content-type': 'application/json' } });
    const { res } = mockRes();
    const next = vi.fn();

    contentTypeEnforcement(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('allows GET requests regardless of content-type', () => {
    const req = mockReq({ method: 'GET', headers: {} });
    const { res } = mockRes();
    const next = vi.fn();

    contentTypeEnforcement(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('rejects POST with non-JSON content-type', () => {
    const req = mockReq({ method: 'POST', headers: { 'content-type': 'application/xml' } });
    const { res, status, json } = mockRes();
    const next = vi.fn();

    contentTypeEnforcement(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(415);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: 'unsupported_media_type' }));
  });

  it('allows PUT with application/json', () => {
    const req = mockReq({ method: 'PUT', headers: { 'content-type': 'application/json; charset=utf-8' } });
    const { res } = mockRes();
    const next = vi.fn();

    contentTypeEnforcement(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('rejects text/html on data routes', () => {
    const req = mockReq({ method: 'POST', path: '/api/v1/fund', headers: { 'content-type': 'text/html' } });
    const { res, status } = mockRes();
    const next = vi.fn();

    contentTypeEnforcement(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(415);
  });

  it('rejects text/xml on data routes', () => {
    const req = mockReq({ method: 'POST', path: '/api/v1/fund', headers: { 'content-type': 'text/xml' } });
    const { res, status } = mockRes();
    const next = vi.fn();

    contentTypeEnforcement(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(415);
  });

  it('allows text/* on webhook routes', () => {
    const req = mockReq({ method: 'POST', path: '/api/webhook/events', headers: { 'content-type': 'text/plain' } });
    const { res } = mockRes();
    const next = vi.fn();

    contentTypeEnforcement(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });
});

describe('requestSizeLimiting middleware', () => {
  it('passes requests under the size limit', () => {
    const req = mockReq({ headers: { 'content-type': 'application/json', 'content-length': '100' } });
    const { res } = mockRes();
    const next = vi.fn();

    requestSizeLimiting(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('blocks requests exceeding json size limit (32kb)', () => {
    const req = mockReq({ headers: { 'content-type': 'application/json', 'content-length': String(33 * 1024) } });
    const { res, status, json } = mockRes();
    const next = vi.fn();

    requestSizeLimiting(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(413);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: 'payload_too_large' }));
  });

  it('passes requests with no content-length', () => {
    const req = mockReq({ headers: { 'content-type': 'application/json' } });
    const { res } = mockRes();
    const next = vi.fn();

    requestSizeLimiting(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('blocks requests with content-length exceeding text/plain limit (8kb)', () => {
    const req = mockReq({ headers: { 'content-type': 'text/plain', 'content-length': String(9 * 1024) } });
    const { res, status, json } = mockRes();
    const next = vi.fn();

    requestSizeLimiting(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(413);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: 'payload_too_large' }));
  });

  it('blocks requests with content-length exceeding form-urlencoded limit (16kb)', () => {
    const req = mockReq({
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': String(17 * 1024) },
    });
    const { res, status } = mockRes();
    const next = vi.fn();

    requestSizeLimiting(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(413);
  });
});

describe('sanitizeErrorMessage', () => {
  it('strips HTML tags', () => {
    expect(sanitizeErrorMessage('<b>error</b>')).toBe('error');
  });

  it('strips javascript: URIs', () => {
    expect(sanitizeErrorMessage('click javascript:void(0)')).toBe('click void(0)');
  });

  it('leaves plain text intact', () => {
    expect(sanitizeErrorMessage('simple error message')).toBe('simple error message');
  });
});
