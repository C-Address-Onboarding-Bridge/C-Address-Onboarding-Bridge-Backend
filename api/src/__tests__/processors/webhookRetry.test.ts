import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { Job } from 'bullmq';
import { processWebhookRetry } from '../../jobs/processors/webhookRetry';

process.env.NODE_ENV = 'test';

const mockWebhookDeliveryService = {
  getRegistration: vi.fn(),
};

vi.mock('../../services/webhookDelivery', () => ({
  webhookDeliveryService: mockWebhookDeliveryService,
}));

vi.mock('../../index', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

describe('Webhook Retry Processor', () => {
  let mockJob: Partial<Job>;
  let mockLogger: any;

  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();

    mockJob = {
      id: 'webhook-retry-job-1',
      data: {
        registrationId: 'webhook-reg-123',
        event: 'transaction.created',
        payload: JSON.stringify({ txId: 'tx-456', amount: '100' }),
        signature: 'sha256hash123',
        data: { txId: 'tx-456' },
        attemptNumber: 0,
      },
    };

    mockLogger = require('../../index').logger;
    mockWebhookDeliveryService.getRegistration.mockReturnValue({
      id: 'webhook-reg-123',
      url: 'https://example.com/webhook',
      active: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('successfully delivers webhook on successful response', async () => {
    const mockResponse = {
      ok: true,
      status: 200,
    };
    (global.fetch as any).mockResolvedValueOnce(mockResponse);

    await processWebhookRetry(mockJob as Job);

    expect(global.fetch).toHaveBeenCalledWith('https://example.com/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': 'sha256=sha256hash123',
        'X-Webhook-Event': 'transaction.created',
        'X-Webhook-Attempt': '1',
      },
      body: mockJob.data?.payload,
      signal: expect.any(AbortSignal),
    });

    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        registrationId: 'webhook-reg-123',
        event: 'transaction.created',
        attempt: 1,
      }),
      'webhook retry delivered successfully',
    );
  });

  it('handles non-2xx response status', async () => {
    const mockResponse = {
      ok: false,
      status: 500,
    };
    (global.fetch as any).mockResolvedValueOnce(mockResponse);

    await processWebhookRetry(mockJob as Job);

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        registrationId: 'webhook-reg-123',
        status: 500,
        attempt: 1,
      }),
      'webhook retry delivery failed with non-2xx status',
    );
  });

  it('handles fetch timeout/abort', async () => {
    const error = new Error('AbortError');
    (global.fetch as any).mockRejectedValueOnce(error);

    await processWebhookRetry(mockJob as Job);

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        registrationId: 'webhook-reg-123',
        error: 'AbortError',
        attempt: 1,
      }),
      'webhook retry delivery error',
    );
  });

  it('handles network errors', async () => {
    const error = new Error('Network timeout');
    (global.fetch as any).mockRejectedValueOnce(error);

    await processWebhookRetry(mockJob as Job);

    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it('logs to error level when max retries exhausted', async () => {
    mockJob.data = {
      ...mockJob.data,
      attemptNumber: 2, // 3rd attempt (0-indexed)
    };

    const mockResponse = {
      ok: false,
      status: 500,
    };
    (global.fetch as any).mockResolvedValueOnce(mockResponse);

    await processWebhookRetry(mockJob as Job);

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        registrationId: 'webhook-reg-123',
        event: 'transaction.created',
        attempt: 3,
      }),
      'webhook retry exhausted, moving to DLQ',
    );
  });

  it('abandons retry when registration not found', async () => {
    mockWebhookDeliveryService.getRegistration.mockReturnValueOnce(null);

    await processWebhookRetry(mockJob as Job);

    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        registrationId: 'webhook-reg-123',
        event: 'transaction.created',
      }),
      'webhook registration not found, abandoning retry',
    );
  });

  it('includes attempt number in headers', async () => {
    mockJob.data = {
      ...mockJob.data,
      attemptNumber: 2,
    };

    const mockResponse = { ok: true, status: 200 };
    (global.fetch as any).mockResolvedValueOnce(mockResponse);

    await processWebhookRetry(mockJob as Job);

    const callArgs = (global.fetch as any).mock.calls[0];
    expect(callArgs[1].headers['X-Webhook-Attempt']).toBe('3'); // attemptNumber + 1
  });

  it('includes event name in headers', async () => {
    mockJob.data = {
      ...mockJob.data,
      event: 'payment.processed',
    };

    const mockResponse = { ok: true, status: 200 };
    (global.fetch as any).mockResolvedValueOnce(mockResponse);

    await processWebhookRetry(mockJob as Job);

    const callArgs = (global.fetch as any).mock.calls[0];
    expect(callArgs[1].headers['X-Webhook-Event']).toBe('payment.processed');
  });

  it('includes signature in headers', async () => {
    mockJob.data = {
      ...mockJob.data,
      signature: 'test-signature-hash',
    };

    const mockResponse = { ok: true, status: 200 };
    (global.fetch as any).mockResolvedValueOnce(mockResponse);

    await processWebhookRetry(mockJob as Job);

    const callArgs = (global.fetch as any).mock.calls[0];
    expect(callArgs[1].headers['X-Webhook-Signature']).toBe('sha256=test-signature-hash');
  });

  it('sends payload in request body', async () => {
    const payload = JSON.stringify({ txId: 'tx-789', status: 'completed' });
    mockJob.data = {
      ...mockJob.data,
      payload,
    };

    const mockResponse = { ok: true, status: 200 };
    (global.fetch as any).mockResolvedValueOnce(mockResponse);

    await processWebhookRetry(mockJob as Job);

    const callArgs = (global.fetch as any).mock.calls[0];
    expect(callArgs[1].body).toBe(payload);
  });

  it('applies timeout to fetch request', async () => {
    const mockResponse = { ok: true, status: 200 };
    (global.fetch as any).mockResolvedValueOnce(mockResponse);

    vi.useFakeTimers();

    const promise = processWebhookRetry(mockJob as Job);

    // Fast-forward time to trigger timeout
    vi.advanceTimersByTime(10_000);

    await promise;

    vi.useRealTimers();

    // Verify that fetch was called with AbortSignal
    const callArgs = (global.fetch as any).mock.calls[0];
    expect(callArgs[1].signal).toBeDefined();
  });

  it('handles string errors from fetch', async () => {
    (global.fetch as any).mockRejectedValueOnce('Network error string');

    await processWebhookRetry(mockJob as Job);

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'Network error string',
      }),
      'webhook retry delivery error',
    );
  });

  it('uses POST method for webhook delivery', async () => {
    const mockResponse = { ok: true, status: 200 };
    (global.fetch as any).mockResolvedValueOnce(mockResponse);

    await processWebhookRetry(mockJob as Job);

    const callArgs = (global.fetch as any).mock.calls[0];
    expect(callArgs[1].method).toBe('POST');
  });

  it('includes Content-Type application/json header', async () => {
    const mockResponse = { ok: true, status: 200 };
    (global.fetch as any).mockResolvedValueOnce(mockResponse);

    await processWebhookRetry(mockJob as Job);

    const callArgs = (global.fetch as any).mock.calls[0];
    expect(callArgs[1].headers['Content-Type']).toBe('application/json');
  });
});
