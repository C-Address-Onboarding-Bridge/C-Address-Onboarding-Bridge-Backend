import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Job } from 'bullmq';
import { processAuditLog } from '../../jobs/processors/asyncAuditLog';

process.env.NODE_ENV = 'test';

vi.mock('../../services/auditLog', () => ({
  integrityAuditLog: {
    append: vi.fn(),
  },
}));

vi.mock('../../services/metrics', () => ({
  asyncPipelineJobDuration: {
    startTimer: vi.fn(() => vi.fn()),
  },
  asyncPipelineFailureCounter: {
    inc: vi.fn(),
  },
}));

vi.mock('pino', () => ({
  default: () => ({
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

describe('Audit Log Processor', () => {
  let mockJob: Partial<Job>;
  let auditLogService: any;
  let metricsService: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockJob = {
      id: 'test-job-123',
      data: {
        type: 'TRANSACTION_CREATED',
        payload: { txId: 'tx-123', amount: '100' },
        actor: 'user-456',
        triggeredAt: Date.now(),
      },
    };

    auditLogService = require('../../services/auditLog');
    metricsService = require('../../services/metrics');
  });

  it('processes audit log successfully', async () => {
    await processAuditLog(mockJob as Job);

    expect(auditLogService.integrityAuditLog.append).toHaveBeenCalledWith({
      type: 'TRANSACTION_CREATED',
      payload: { txId: 'tx-123', amount: '100' },
      actor: 'user-456',
      triggeredAt: mockJob.data?.triggeredAt,
    });
  });

  it('records job duration even on success', async () => {
    await processAuditLog(mockJob as Job);

    const timerFn = metricsService.asyncPipelineJobDuration.startTimer();
    expect(timerFn).toHaveBeenCalled();
  });

  it('increments failure counter and logs error on exception', async () => {
    const error = new Error('Audit log append failed');
    auditLogService.integrityAuditLog.append.mockImplementation(() => {
      throw error;
    });

    await expect(processAuditLog(mockJob as Job)).rejects.toThrow('Audit log append failed');
    expect(metricsService.asyncPipelineFailureCounter.inc).toHaveBeenCalled();
  });

  it('handles different audit event types', async () => {
    const eventTypes = ['USER_CREATED', 'PERMISSION_GRANTED', 'WEBHOOK_FAILED'];

    for (const eventType of eventTypes) {
      mockJob.data = {
        ...mockJob.data,
        type: eventType as any,
      };

      await processAuditLog(mockJob as Job);

      expect(auditLogService.integrityAuditLog.append).toHaveBeenCalledWith(
        expect.objectContaining({
          type: eventType,
        }),
      );
    }
  });

  it('passes correct job ID to logger', async () => {
    mockJob.id = 'unique-job-id-789';
    await processAuditLog(mockJob as Job);

    expect(auditLogService.integrityAuditLog.append).toHaveBeenCalled();
  });

  it('handles complex payload objects', async () => {
    const complexPayload = {
      txId: 'tx-123',
      amounts: [100, 200, 300],
      nested: {
        level1: {
          level2: 'deep-value',
        },
      },
      timestamp: Date.now(),
    };

    mockJob.data = {
      ...mockJob.data,
      payload: complexPayload,
    };

    await processAuditLog(mockJob as Job);

    expect(auditLogService.integrityAuditLog.append).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: complexPayload,
      }),
    );
  });
});
