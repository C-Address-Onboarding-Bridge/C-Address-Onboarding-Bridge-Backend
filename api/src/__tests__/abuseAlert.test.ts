import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../logger', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

import { logger } from '../logger';

const ALERT_URL = 'https://admin.example.com/alerts';

async function loadModule() {
  return import('../services/abuseAlert');
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

afterEach(() => {
  delete process.env.ADMIN_ALERT_URL;
  vi.unstubAllGlobals();
});

describe('sendAbuseAlert', () => {
  it('logs every alert at error level', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { sendAbuseAlert } = await loadModule();
    await sendAbuseAlert({ type: 'ip_banned', ip: '10.0.0.1', pattern: 'large_amount' });

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        alert: true,
        abuse: expect.objectContaining({ type: 'ip_banned', ip: '10.0.0.1' }),
      }),
      'abuse detected: ip_banned',
    );
  });

  it('does not call the webhook when ADMIN_ALERT_URL is unset', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { sendAbuseAlert } = await loadModule();
    await sendAbuseAlert({ type: 'suspicious_activity', ip: '10.0.0.2' });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts the enriched payload to ADMIN_ALERT_URL when configured', async () => {
    process.env.ADMIN_ALERT_URL = ALERT_URL;
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const { sendAbuseAlert } = await loadModule();
    await sendAbuseAlert({ type: 'cost_limit_exceeded', ip: '10.0.0.3', apiKeyId: 'key-1', details: { totalCost: 1_000_001 } });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(ALERT_URL);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'content-type': 'application/json' });

    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      type: 'cost_limit_exceeded',
      ip: '10.0.0.3',
      apiKeyId: 'key-1',
      details: { totalCost: 1_000_001 },
      service: 'bridge-api',
    });
    expect(Date.parse(body.timestamp)).not.toBeNaN();
  });

  it('swallows delivery failures so abuse detection never throws', async () => {
    process.env.ADMIN_ALERT_URL = ALERT_URL;
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);

    const { sendAbuseAlert } = await loadModule();
    await expect(sendAbuseAlert({ type: 'ip_banned', ip: '10.0.0.4' })).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'failed to deliver admin abuse alert',
    );
  });
});
