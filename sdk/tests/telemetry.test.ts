import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TelemetryClient } from '../src/telemetry';
import { NoopTelemetryTransport, FetchTelemetryTransport } from '../src/telemetry';

describe('NoopTelemetryTransport', () => {
  it('send does not throw', () => {
    const transport = new NoopTelemetryTransport();
    expect(() =>
      transport.send({
        sdkVersion: '1.0.0',
        nodeVersion: 'v20.0.0',
        platform: 'linux',
        method: 'getQuote',
        responseTimeMs: 10,
      }),
    ).not.toThrow();
  });
});

describe('FetchTelemetryTransport', () => {
  it('send makes a POST request to the endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const transport = new FetchTelemetryTransport('https://telemetry.example.com');
    transport.send({
      sdkVersion: '1.0.0',
      nodeVersion: 'v20.0.0',
      platform: 'linux',
      method: 'getQuote',
      responseTimeMs: 10,
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://telemetry.example.com');
    expect(options.method).toBe('POST');
    expect(options.headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(options.body);
    expect(body.method).toBe('getQuote');
    expect(body.responseTimeMs).toBe(10);

    vi.restoreAllMocks();
  });

  it('send does not throw on fetch failure', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error('network error'));
    vi.stubGlobal('fetch', fetchMock);

    const transport = new FetchTelemetryTransport('https://telemetry.example.com');
    expect(() =>
      transport.send({
        sdkVersion: '1.0.0',
        nodeVersion: 'v20.0.0',
        platform: 'linux',
        method: 'getQuote',
        responseTimeMs: 10,
      }),
    ).not.toThrow();

    vi.restoreAllMocks();
  });
});

describe('TelemetryClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('does not flush when disabled', async () => {
    const sendMock = vi.fn();
    const transport = { send: sendMock };
    const client = new TelemetryClient({
      enabled: false,
      endpoint: 'https://telemetry.example.com',
      transport,
      intervalMs: 60_000,
    });

    client.record({ method: 'getQuote', responseTimeMs: 10 });
    vi.advanceTimersByTime(60_000);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sendMock).not.toHaveBeenCalled();
  });

  it('queues and flushes events on interval', async () => {
    const sendMock = vi.fn();
    const transport = { send: sendMock };
    const client = new TelemetryClient({
      enabled: true,
      endpoint: 'https://telemetry.example.com',
      transport,
      intervalMs: 60_000,
    });

    client.record({ method: 'getQuote', responseTimeMs: 10 });

    vi.advanceTimersByTime(60_000);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sendMock).toHaveBeenCalledOnce();
    const sentEvent = sendMock.mock.calls[0][0];
    expect(sentEvent.method).toBe('getQuote');
    expect(sentEvent.responseTimeMs).toBe(10);
  });

  it('caps the queue size and drops oldest entries on flush', async () => {
    const sendMock = vi.fn();
    const transport = { send: sendMock };
    const client = new TelemetryClient({
      enabled: true,
      endpoint: 'https://telemetry.example.com',
      transport,
      intervalMs: 60_000,
      maxQueueSize: 3,
    });

    client.record({ method: 'a', responseTimeMs: 1 });
    client.record({ method: 'b', responseTimeMs: 2 });
    client.record({ method: 'c', responseTimeMs: 3 });
    client.record({ method: 'd', responseTimeMs: 4 });

    vi.advanceTimersByTime(60_000);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sendMock).toHaveBeenCalledTimes(3);
    const methods = sendMock.mock.calls.map((c: unknown[]) => (c[0] as { method: string }).method);
    expect(methods).toEqual(['b', 'c', 'd']);
  });

  it('does not flush when no endpoint is configured', async () => {
    const sendMock = vi.fn();
    const transport = { send: sendMock };
    const client = new TelemetryClient({
      enabled: true,
      transport,
      intervalMs: 60_000,
    });

    client.record({ method: 'getQuote', responseTimeMs: 10 });
    vi.advanceTimersByTime(60_000);

    expect(sendMock).not.toHaveBeenCalled();
  });

  it('queue does not grow unboundedly with no endpoint configured', async () => {
    const sendMock = vi.fn();
    const transport = { send: sendMock };
    const client = new TelemetryClient({
      enabled: true,
      transport,
      intervalMs: 60_000,
      maxQueueSize: 5,
    });

    for (let i = 0; i < 100; i++) {
      client.record({ method: 'getQuote', responseTimeMs: 10 });
    }

    vi.advanceTimersByTime(60_000);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sendMock).not.toHaveBeenCalled();
  });
});