import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetPool, mockQuery } = vi.hoisted(() => ({
  mockGetPool: vi.fn(),
  mockQuery: vi.fn(),
}));

vi.mock('../services/db', () => ({
  getPool: mockGetPool,
}));

import { IntegrityAuditLogService } from '../services/auditLog';

describe('audit checkpoint persistence', () => {
  beforeEach(() => {
    mockGetPool.mockReturnValue(null);
    mockQuery.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses a local fallback when the timestamp service returns an error status', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: vi.fn().mockResolvedValue('not an anchor'),
    });
    vi.stubGlobal('fetch', fetchMock);
    const service = new IntegrityAuditLogService({
      checkpointInterval: 1,
      checkpointUrl: 'https://timestamp.example/checkpoint',
    });

    service.append('admin_operation', { action: 'test' });

    await vi.waitFor(() => expect(service.listCheckpoints()).toHaveLength(1));
    expect(service.listCheckpoints()[0]).toMatchObject({
      publisher: 'local',
      publicationRef: expect.stringContaining('local-fallback'),
    });
  });

  it('stores the timestamp receipt and applies a request timeout', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: vi.fn().mockResolvedValue('receipt-token'),
    });
    vi.stubGlobal('fetch', fetchMock);
    const service = new IntegrityAuditLogService({
      checkpointInterval: 1,
      checkpointUrl: 'https://timestamp.example/checkpoint',
    });

    service.append('admin_operation', { action: 'test' });

    await vi.waitFor(() => expect(service.listCheckpoints()).toHaveLength(1));
    expect(service.listCheckpoints()[0]).toMatchObject({
      publisher: 'trusted-timestamp',
      publicationRef: 'receipt-token',
    });
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it('waits for the entry insert before issuing the checkpoint insert', async () => {
    const events: string[] = [];
    let releaseEntryInsert!: () => void;
    const entryInsert = new Promise<void>((resolve) => {
      releaseEntryInsert = resolve;
    });
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO audit_log_entries')) {
        events.push('entry_started');
        await entryInsert;
        events.push('entry_completed');
      } else if (sql.includes('INSERT INTO audit_log_checkpoints')) {
        events.push('checkpoint_inserted');
      }
      return { rows: [] };
    });
    mockGetPool.mockReturnValue({ query: mockQuery });
    const service = new IntegrityAuditLogService({ checkpointInterval: 1 });

    service.append('admin_operation', { action: 'test' });
    await Promise.resolve();
    expect(events).toEqual(['entry_started']);

    releaseEntryInsert();
    await vi.waitFor(() => expect(events).toContain('checkpoint_inserted'));
    expect(events).toEqual(['entry_started', 'entry_completed', 'checkpoint_inserted']);
  });
});
