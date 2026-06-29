import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

process.env.NODE_ENV = 'test';
process.env.API_KEYS = 'test-api-key-123';

vi.mock('../index', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { WebhookDeliveryService } from '../services/webhookDelivery';

describe('WebhookDeliveryService', () => {
  let service: WebhookDeliveryService;

  beforeEach(() => {
    service = new WebhookDeliveryService();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('register / unregister', () => {
    it('registers and returns a registration with a unique id', () => {
      const reg = service.register({ url: 'https://example.com/hook', secret: 'supersecretvalue!', apiKey: 'key1', events: ['*'] });
      expect(reg.id).toBeTruthy();
      expect(reg.url).toBe('https://example.com/hook');
      expect(reg.apiKey).toBe('key1');
    });

    it('returns different ids for different registrations', () => {
      const r1 = service.register({ url: 'https://a.com', secret: 'secretvalue12345', apiKey: 'k', events: ['*'] });
      const r2 = service.register({ url: 'https://b.com', secret: 'secretvalue12345', apiKey: 'k', events: ['*'] });
      expect(r1.id).not.toBe(r2.id);
    });

    it('unregisters a registration', () => {
      const reg = service.register({ url: 'https://example.com', secret: 'secretvalue12345', apiKey: 'k', events: ['*'] });
      expect(service.unregister(reg.id)).toBe(true);
      expect(service.getRegistration(reg.id)).toBeUndefined();
    });

    it('returns false when unregistering unknown id', () => {
      expect(service.unregister('nonexistent-id')).toBe(false);
    });
  });

  describe('getRegistrationsByApiKey', () => {
    it('filters registrations by api key', () => {
      service.register({ url: 'https://a.com', secret: 'secretvalue12345', apiKey: 'key-A', events: ['*'] });
      service.register({ url: 'https://b.com', secret: 'secretvalue12345', apiKey: 'key-B', events: ['*'] });
      service.register({ url: 'https://c.com', secret: 'secretvalue12345', apiKey: 'key-A', events: ['tx'] });

      const results = service.getRegistrationsByApiKey('key-A');
      expect(results).toHaveLength(2);
      expect(results.every((r) => r.apiKey === 'key-A')).toBe(true);
    });
  });

  describe('sign', () => {
    it('produces a hex HMAC-SHA256 signature', () => {
      const sig = service.sign('{"event":"test"}', 'mysecret');
      expect(sig).toMatch(/^[a-f0-9]{64}$/);
    });

    it('produces different signatures for different secrets', () => {
      const sig1 = service.sign('payload', 'secret1');
      const sig2 = service.sign('payload', 'secret2');
      expect(sig1).not.toBe(sig2);
    });

    it('produces the same signature for the same inputs', () => {
      const sig1 = service.sign('payload', 'secret');
      const sig2 = service.sign('payload', 'secret');
      expect(sig1).toBe(sig2);
    });
  });

  describe('deliver — success path', () => {
    it('POSTs payload with HMAC signature header on success', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal('fetch', fetchMock);

      const reg = service.register({ url: 'https://example.com/hook', secret: 'mysecret123456!', apiKey: 'k', events: ['*'] });
      await service.deliver(reg, 'transaction.success', { txHash: 'abc' });

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe('https://example.com/hook');
      expect(opts.method).toBe('POST');
      expect(opts.headers['X-Webhook-Signature']).toMatch(/^sha256=[a-f0-9]{64}$/);
      expect(opts.headers['X-Webhook-Event']).toBe('transaction.success');
    });
  });

  describe('deliver — retry path', () => {
    it('retries on HTTP 500 and moves to DLQ after max retries', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 });
      vi.stubGlobal('fetch', fetchMock);

      const reg = service.register({ url: 'https://example.com/hook', secret: 'mysecret123456!', apiKey: 'k', events: ['*'] });
      await service.deliver(reg, 'tx.failed', { txHash: 'deadbeef' });

      // Initial attempt
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(service.getDLQ()).toHaveLength(0);

      // First retry after 10s
      await vi.advanceTimersByTimeAsync(10_000);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      // Second retry after 60s
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetchMock).toHaveBeenCalledTimes(3);

      // Third retry after 300s → DLQ
      await vi.advanceTimersByTimeAsync(300_000);
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(service.getDLQ()).toHaveLength(1);
    });
  });

  describe('DLQ', () => {
    it('getDLQEntry returns the correct entry', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503 });
      vi.stubGlobal('fetch', fetchMock);

      const reg = service.register({ url: 'https://fail.example', secret: 'mysecret123456!', apiKey: 'k', events: ['*'] });
      await service.deliver(reg, 'tx.failed', { txHash: '1234' });
      await vi.advanceTimersByTimeAsync(10_000 + 60_000 + 300_000);

      const dlq = service.getDLQ();
      expect(dlq).toHaveLength(1);
      const entry = service.getDLQEntry(dlq[0].id);
      expect(entry).toBeDefined();
      expect(entry!.event).toBe('tx.failed');
    });

    it('deleteDLQEntry removes the entry', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503 });
      vi.stubGlobal('fetch', fetchMock);

      const reg = service.register({ url: 'https://fail.example', secret: 'mysecret123456!', apiKey: 'k', events: ['*'] });
      await service.deliver(reg, 'tx.failed', { txHash: '5678' });
      await vi.advanceTimersByTimeAsync(10_000 + 60_000 + 300_000);

      const dlq = service.getDLQ();
      const id = dlq[0].id;
      expect(service.deleteDLQEntry(id)).toBe(true);
      expect(service.getDLQ()).toHaveLength(0);
    });

    it('deleteDLQEntry returns false for unknown id', () => {
      expect(service.deleteDLQEntry('nonexistent')).toBe(false);
    });
  });

  describe('getStats', () => {
    it('returns correct stats', () => {
      service.register({ url: 'https://a.com', secret: 'secretvalue12345', apiKey: 'k', events: ['*'] });
      service.register({ url: 'https://b.com', secret: 'secretvalue12345', apiKey: 'k', events: ['*'] });
      const stats = service.getStats();
      expect(stats.registered).toBe(2);
      expect(stats.dlqSize).toBe(0);
    });
  });
});
