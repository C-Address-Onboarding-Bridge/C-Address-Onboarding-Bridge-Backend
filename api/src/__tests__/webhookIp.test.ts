import { describe, expect, it, vi } from 'vitest';

vi.mock('../index', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../jobs/queue', () => ({
  enqueueWebhookRetry: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/asyncPipeline', () => ({
  enqueueAudit: vi.fn(),
}));

vi.mock('../services/auditLog', () => ({
  hashPayload: vi.fn(() => 'mock-hash'),
  integrityAuditLog: { append: vi.fn() },
}));

import { isBlockedIp } from '../services/webhookDelivery';

describe('isBlockedIp', () => {
  it.each([
    '[::ffff:a9fe:a9fe]',
    '[::7f00:1]',
    '[64:ff9b::a9fe:a9fe]',
    '[2002:a9fe:a9fe::]',
  ])('blocks embedded private IPv4 in %s', (address) => {
    expect(isBlockedIp(address)).toBe(true);
  });

  it('allows a public IPv6 address', () => {
    expect(isBlockedIp('2606:4700:4700::1111')).toBe(false);
  });
});