import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const undiciAgentState = vi.hoisted(() => ({ options: undefined as unknown }));

vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return {
    ...actual,
    Agent: class TestAgent extends actual.Agent {
      constructor(options: ConstructorParameters<typeof actual.Agent>[0]) {
        super(options);
        undiciAgentState.options = options;
      }
    },
  };
});

vi.mock('node:dns/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns/promises')>();
  return { ...actual, lookup: vi.fn(actual.lookup) };
});

process.env.NODE_ENV = 'test';
process.env.API_KEYS = 'test-api-key-123';

vi.mock('../index', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../jobs/queue', () => ({
  enqueueWebhookRetry: vi.fn().mockResolvedValue(undefined),
  WEBHOOK_RETRY_DELAYS_MS: [10_000, 60_000, 300_000],
  enqueueAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/asyncPipeline', () => ({
  enqueueAudit: vi.fn(),
}));

vi.mock('../services/auditLog', () => ({
  hashPayload: vi.fn(() => 'mock-hash'),
  integrityAuditLog: {
    append: vi.fn(),
  },
}));

import { WebhookDeliveryService } from '../services/webhookDelivery';
import { enqueueWebhookRetry } from '../jobs/queue';
import { lookup } from 'node:dns/promises';

function dnsAddresses(addresses: { address: string; family: number }[]): Awaited<ReturnType<typeof lookup>> {
  return addresses as unknown as Awaited<ReturnType<typeof lookup>>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('WebhookDeliveryService', () => {
  let service: WebhookDeliveryService;

  beforeEach(() => {
    service = new WebhookDeliveryService();
    vi.clearAllMocks();
    vi.mocked(lookup).mockReset().mockResolvedValue(dnsAddresses([{ address: '93.184.216.34', family: 4 }]));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('register / unregister', () => {
    it('registers and returns a registration with a unique id', () => {
      const reg = service.register({ url: 'https://example.com/hook', secret: 'supersecretvalue!', apiKeyId: 'key1', events: ['*'] });
      expect(reg.id).toBeTruthy();
      expect(reg.url).toBe('https://example.com/hook');
      expect(reg.apiKeyId).toBe('key1');
    });

    it('returns different ids for different registrations', () => {
      const r1 = service.register({ url: 'https://a.com', secret: 'secretvalue12345', apiKeyId: 'k', events: ['*'] });
      const r2 = service.register({ url: 'https://b.com', secret: 'secretvalue12345', apiKeyId: 'k', events: ['*'] });
      expect(r1.id).not.toBe(r2.id);
    });

    it('unregisters a registration', () => {
      const reg = service.register({ url: 'https://example.com', secret: 'secretvalue12345', apiKeyId: 'k', events: ['*'] });
      expect(service.unregister(reg.id)).toBe(true);
      expect(service.getRegistration(reg.id)).toBeUndefined();
    });

    it('returns false when unregistering unknown id', () => {
      expect(service.unregister('nonexistent-id')).toBe(false);
    });
  });

  describe('getRegistrationsByApiKey', () => {
    it('filters registrations by api key', () => {
      service.register({ url: 'https://a.com', secret: 'secretvalue12345', apiKeyId: 'key-A', events: ['*'] });
      service.register({ url: 'https://b.com', secret: 'secretvalue12345', apiKeyId: 'key-B', events: ['*'] });
      service.register({ url: 'https://c.com', secret: 'secretvalue12345', apiKeyId: 'key-A', events: ['tx'] });

      const results = service.getRegistrationsByApiKey('key-A');
      expect(results).toHaveLength(2);
      expect(results.every((r) => r.apiKeyId === 'key-A')).toBe(true);
    });
  });

  describe('sign', () => {
    it('produces a hex HMAC-SHA256 signature (legacy 2-arg form)', () => {
      const sig = service.sign('{"event":"test"}', 'mysecret');
      expect(sig).toMatch(/^[a-f0-9]{64}$/);
    });

    it('3-arg form binds the timestamp into the signed message', () => {
      const ts = 1_700_000_000;
      const payload = '{"event":"test"}';
      const bound = service.sign(payload, 'mysecret', ts);
      const bare = service.sign(payload, 'mysecret');
      expect(bound).not.toBe(bare);
      expect(bound).toMatch(/^[a-f0-9]{64}$/);
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

  describe('deliver - success path', () => {
    it('POSTs payload with canonical webhook headers on success', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal('fetch', fetchMock);

      const reg = service.register({ url: 'https://example.com/hook', secret: 'mysecret123456!', apiKeyId: 'k', events: ['*'] });
      await service.deliver(reg, 'transaction.success', { txHash: 'abc' });

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe('https://example.com/hook');
      expect(opts.method).toBe('POST');

      // Issue #1060: canonical header contract.
      expect(opts.headers['Content-Type']).toBe('application/json');
      expect(opts.headers['X-Webhook-Signature']).toMatch(/^sha256=[a-f0-9]{64}$/);
      expect(opts.headers['X-Webhook-Timestamp']).toMatch(/^\d{10}$/);
      expect(opts.headers['X-Webhook-Event']).toBe('transaction.success');
      expect(opts.headers['X-Webhook-Attempt']).toBe('1');

      // Issue #1061: a stable delivery ID is stamped on every attempt.
      expect(opts.headers['X-Webhook-Id']).toMatch(UUID_RE);

      // The body's timestamp is in seconds and matches the header.
      const body = JSON.parse(opts.body);
      expect(body.timestamp).toBe(Number(opts.headers['X-Webhook-Timestamp']));
    });

    it('pins delivery to the public DNS answer when the hostname is rebound', async () => {
      const lookupMock = vi.mocked(lookup)
        .mockResolvedValueOnce(dnsAddresses([{ address: '93.184.216.34', family: 4 }]))
        .mockResolvedValueOnce(dnsAddresses([{ address: '127.0.0.1', family: 4 }]));
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal('fetch', fetchMock);

      const reg = service.register({
        url: 'https://rebind.example/hook',
        secret: 'mysecret123456!',
        apiKey: 'k',
        events: ['*'],
      });
      await service.deliver(reg, 'transaction.success', { txHash: 'abc' });

      expect(lookupMock).toHaveBeenCalledOnce();
      expect(lookupMock).toHaveBeenCalledWith('rebind.example', { all: true, verbatim: true });

      const fetchOptions = fetchMock.mock.calls[0][1] as RequestInit & { dispatcher: unknown };
      expect(fetchMock.mock.calls[0][0]).toBe('https://rebind.example/hook');
      expect(fetchOptions.dispatcher).toBeDefined();

      const connect = (undiciAgentState.options as {
        connect: {
          lookup: (
            _hostname: string,
            _options: { all?: boolean },
            _callback: (_error: Error | null, _addresses: { address: string; family: number }[]) => void,
          ) => void;
        };
      }).connect;
      const connectedAddresses = await new Promise<{ address: string; family: number }[]>((resolve, reject) => {
        connect.lookup('rebind.example', { all: true }, (error, addresses) => {
          if (error) reject(error);
          else resolve(addresses);
        });
      });

      expect(connectedAddresses).toEqual([{ address: '93.184.216.34', family: 4 }]);
      expect(connectedAddresses).not.toContainEqual({ address: '127.0.0.1', family: 4 });
    });
  });

  describe('deliver - redirect protection', () => {
    it('passes redirect: "error" so a 307 cannot redirect to a private address', async () => {
      const redirectError = Object.assign(new TypeError('fetch failed'), {
        cause: new Error('unexpected redirect: 307'),
      });
      const fetchMock = vi.fn().mockRejectedValue(redirectError);
      vi.stubGlobal('fetch', fetchMock);
      const enqueueMock = vi.mocked(enqueueWebhookRetry);

      const reg = service.register({
        url: 'https://public.example/hook',
        secret: 'mysecret123456!',
        apiKeyId: 'k',
        events: ['*'],
      });
      await service.deliver(reg, 'tx.failed', { txHash: 'abc' });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe('https://public.example/hook');
      const fetchOptions = fetchMock.mock.calls[0][1] as RequestInit;
      expect(fetchOptions.redirect).toBe('error');
      expect(enqueueMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('deliver - retry path', () => {
    it('enqueues retries with webhookId + raw payload but no signature or timestamp', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 });
      vi.stubGlobal('fetch', fetchMock);
      const enqueueMock = vi.mocked(enqueueWebhookRetry);

      const reg = service.register({ url: 'https://example.com/hook', secret: 'mysecret123456!', apiKeyId: 'k', events: ['*'] });
      await service.deliver(reg, 'tx.failed', { txHash: 'deadbeef' });

      const attempt1 = fetchMock.mock.calls[0][1] as RequestInit;
      const headers = attempt1.headers as Record<string, string>;
      const webhookId = headers['X-Webhook-Id'];
      expect(webhookId).toMatch(UUID_RE);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(enqueueMock).toHaveBeenCalledTimes(1);
      expect(service.getDLQ()).toHaveLength(0);

      // Issue #1061: the retry payload is signature-free and timestamp-free.
      // The worker re-signs with a fresh `now` on every attempt.
      const [retryData, delay] = enqueueMock.mock.calls[0];
      expect(delay).toBe(10_000);
      expect(retryData).toMatchObject({
        registrationId: reg.id,
        url: 'https://example.com/hook',
        event: 'tx.failed',
        attemptNumber: 1,
        webhookId, // same as attempt 1 - dedupe key
        payload: expect.any(String),
      });
      expect(retryData).not.toHaveProperty('signature');
      expect(retryData).not.toHaveProperty('timestamp');
    });

    it('moves to DLQ if webhook retry enqueue fails', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 });
      vi.stubGlobal('fetch', fetchMock);
      const enqueueMock = vi.mocked(enqueueWebhookRetry);
      enqueueMock.mockRejectedValueOnce(new Error('Redis unavailable'));

      const reg = service.register({ url: 'https://example.com/hook', secret: 'mysecret123456!', apiKeyId: 'k', events: ['*'] });
      await service.deliver(reg, 'tx.failed', { txHash: 'deadbeef' });

      expect(service.getDLQ()).toHaveLength(1);
      const entry = service.getDLQ()[0];
      expect(entry.event).toBe('tx.failed');
      // Issue #1061: the DLQ entry records the stable webhookId for future
      // manual replay / dedupe.
      expect(entry.webhookId).toMatch(UUID_RE);
    });
  });

  describe('DLQ', () => {
    it('getDLQEntry returns the correct entry', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503 });
      vi.stubGlobal('fetch', fetchMock);
      const enqueueMock = vi.mocked(enqueueWebhookRetry);

      const reg = service.register({ url: 'https://fail.example', secret: 'mysecret123456!', apiKeyId: 'k', events: ['*'] });
      await service.deliver(reg, 'tx.failed', { txHash: '1234' });

      expect(enqueueMock).toHaveBeenCalledTimes(1);
      expect(service.getDLQ()).toHaveLength(0);

      enqueueMock.mockRejectedValueOnce(new Error('Redis unavailable'));
      await service.deliver(reg, 'tx.failed', { txHash: '1234' });
      expect(service.getDLQ()).toHaveLength(1);

      const dlq = service.getDLQ();
      const entry = service.getDLQEntry(dlq[0].id);
      expect(entry).toBeDefined();
      expect(entry!.event).toBe('tx.failed');
    });

    it('deleteDLQEntry removes the entry', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503 });
      vi.stubGlobal('fetch', fetchMock);
      const enqueueMock = vi.mocked(enqueueWebhookRetry);
      enqueueMock.mockRejectedValueOnce(new Error('Redis unavailable'));

      const reg = service.register({ url: 'https://fail.example', secret: 'mysecret123456!', apiKeyId: 'k', events: ['*'] });
      await service.deliver(reg, 'tx.failed', { txHash: '5678' });

      const dlq = service.getDLQ();
      expect(dlq).toHaveLength(1);
      expect(service.deleteDLQEntry(dlq[0].id)).toBe(true);
      expect(service.getDLQ()).toHaveLength(0);
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
