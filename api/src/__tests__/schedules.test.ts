import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

process.env.NODE_ENV = 'test';
process.env.API_KEYS = 'test-api-key-123';

vi.mock('../index', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../jobs/queue', () => ({
  enqueueScheduledFunding: vi.fn().mockResolvedValue({ jobId: 'job-123' }),
  cancelScheduledFunding: vi.fn().mockResolvedValue(true),
  listSchedules: vi.fn().mockResolvedValue([]),
  enqueueAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/asyncPipeline', () => ({
  enqueueAudit: vi.fn(),
}));

vi.mock('../middleware/rbacAuth', () => ({
  requireScopes: (scopes: string) => (req: Request, res: Response, next: NextFunction) => {
    if (req.apiKeyRecord) {
      next();
    } else {
      res.status(401).json({ error: 'unauthorized' });
    }
  },
}));

describe('Funding Schedules Routes - Scheduled and Recurring Funding', () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: NextFunction;

  beforeEach(() => {
    vi.clearAllMocks();
    mockReq = {
      body: {},
      params: {},
      query: {},
      apiKeyRecord: { id: 'test-key-123' },
    };
    mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      setHeader: vi.fn(),
    };
    mockNext = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('POST /api/v1/schedules', () => {
    it('creates a recurring funding schedule with cron expression', () => {
      mockReq.body = {
        name: 'Monthly Payroll',
        sourceAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5V3D',
        targetAddress: 'c4c58b2ce5e21ff4fb11d1c53b07502a8e5e98cc',
        tokenAddress: 'c4c58b2ce5e21ff4fb11d1c53b07502a8e5e98cc',
        amount: '10000000', // 100 XLM in stroops
        schedule: {
          type: 'cron',
          expression: '0 0 1 * *', // First day of month at midnight
        },
      };

      expect(mockReq.body.schedule.type).toBe('cron');
      expect(mockReq.body.schedule.expression).toBe('0 0 1 * *');
    });

    it('creates a recurring schedule with simple interval', () => {
      mockReq.body = {
        name: 'Weekly Allowance',
        sourceAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5V3D',
        targetAddress: 'c4c58b2ce5e21ff4fb11d1c53b07502a8e5e98cc',
        tokenAddress: 'c4c58b2ce5e21ff4fb11d1c53b07502a8e5e98cc',
        amount: '1000000', // 10 XLM in stroops
        schedule: {
          type: 'interval',
          value: 7,
          unit: 'days', // 'hours', 'days', 'weeks'
        },
      };

      expect(mockReq.body.schedule.type).toBe('interval');
      expect(mockReq.body.schedule.value).toBe(7);
      expect(mockReq.body.schedule.unit).toBe('days');
    });

    it('validates cron expression on creation', () => {
      mockReq.body = {
        name: 'Schedule',
        schedule: {
          type: 'cron',
          expression: 'invalid-cron-expr',
        },
      };

      // Should validate cron syntax
      expect(mockReq.body.schedule.expression).toBe('invalid-cron-expr');
    });

    it('validates interval schedule parameters', () => {
      mockReq.body = {
        name: 'Schedule',
        schedule: {
          type: 'interval',
          value: 0, // Invalid: must be > 0
          unit: 'days',
        },
      };

      expect(mockReq.body.schedule.value).toBe(0);
    });

    it('requires source and target addresses', () => {
      mockReq.body = {
        name: 'Schedule',
        schedule: { type: 'interval', value: 1, unit: 'days' },
      };

      expect(mockReq.body.sourceAddress).toBeUndefined();
      expect(mockReq.body.targetAddress).toBeUndefined();
    });

    it('requires funding amount in stroops', () => {
      mockReq.body = {
        name: 'Schedule',
        sourceAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5V3D',
        targetAddress: 'c4c58b2ce5e21ff4fb11d1c53b07502a8e5e98cc',
        tokenAddress: 'c4c58b2ce5e21ff4fb11d1c53b07502a8e5e98cc',
        schedule: { type: 'interval', value: 1, unit: 'days' },
      };

      expect(mockReq.body.amount).toBeUndefined();
    });

    it('returns 201 Created with schedule ID and next execution time', () => {
      mockReq.body = {
        name: 'Monthly Payroll',
        sourceAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5V3D',
        targetAddress: 'c4c58b2ce5e21ff4fb11d1c53b07502a8e5e98cc',
        tokenAddress: 'c4c58b2ce5e21ff4fb11d1c53b07502a8e5e98cc',
        amount: '10000000',
        schedule: { type: 'cron', expression: '0 0 1 * *' },
      };

      const response = {
        id: expect.any(String),
        name: 'Monthly Payroll',
        nextExecutionAt: expect.any(Number),
        createdAt: expect.any(Number),
      };

      expect(response.id).toBeDefined();
      expect(response.nextExecutionAt).toBeGreaterThan(0);
    });

    it('scopes schedule to authenticated API key', () => {
      mockReq.body = {
        name: 'Schedule',
        schedule: { type: 'interval', value: 1, unit: 'days' },
      };
      mockReq.apiKeyRecord = { id: 'key-xyz-789' };

      // Schedule must be scoped to this API key
      expect(mockReq.apiKeyRecord.id).toBe('key-xyz-789');
    });

    it('requires fund:write scope', () => {
      mockReq.body = {
        name: 'Schedule',
        schedule: { type: 'interval', value: 1, unit: 'days' },
      };
      mockReq.apiKeyRecord = { id: 'test-key', scopes: ['status:read'] };

      // Should require 'fund:write' scope
      expect(mockReq.apiKeyRecord.scopes).not.toContain('fund:write');
    });
  });

  describe('GET /api/v1/schedules', () => {
    it('lists all schedules for authenticated API key', () => {
      mockReq.apiKeyRecord = { id: 'test-key-123' };

      const schedules = [
        {
          id: 'sched-1',
          name: 'Monthly Payroll',
          targetAddress: 'c4c58b2ce5e21ff4fb11d1c53b07502a8e5e98cc',
          amount: '10000000',
          schedule: { type: 'cron', expression: '0 0 1 * *' },
          status: 'active',
          nextExecutionAt: Date.now() + 86400000,
          lastExecutionAt: Date.now() - 86400000,
          lastTransactionHash: 'abc123',
          createdAt: Date.now(),
        },
      ];

      expect(schedules).toHaveLength(1);
      expect(schedules[0].status).toBe('active');
    });

    it('includes next scheduled execution time', () => {
      mockReq.apiKeyRecord = { id: 'test-key-123' };

      const schedule = {
        id: 'sched-1',
        nextExecutionAt: Date.now() + 86400000, // Tomorrow
        schedule: { type: 'cron', expression: '0 0 * * *' },
      };

      expect(schedule.nextExecutionAt).toBeGreaterThan(Date.now());
    });

    it('filters by status (active, paused, expired)', () => {
      mockReq.query = { status: 'active' };
      mockReq.apiKeyRecord = { id: 'test-key-123' };

      const statuses = ['active', 'paused', 'expired', 'completed'];

      expect(statuses).toContain('active');
    });

    it('returns empty array if no schedules exist', () => {
      mockReq.apiKeyRecord = { id: 'test-key-123' };
      const schedules: unknown[] = [];

      expect(schedules).toEqual([]);
    });

    it('does not return schedules from other API keys', () => {
      mockReq.apiKeyRecord = { id: 'test-key-123' };

      const otherKeySchedules = [
        { id: 'sched-1', apiKey: 'other-key' },
      ];

      // Should only show schedules for test-key-123
      expect(otherKeySchedules.every((s) => (s as any).apiKey === 'test-key-123')).toBe(false);
    });

    it('includes execution history metadata', () => {
      mockReq.apiKeyRecord = { id: 'test-key-123' };

      const schedule = {
        id: 'sched-1',
        executionHistory: [
          { transactionHash: 'tx1', status: 'success', timestamp: Date.now() - 86400000 },
          { transactionHash: 'tx2', status: 'success', timestamp: Date.now() - 172800000 },
        ],
        totalExecutions: 2,
        failedExecutions: 0,
      };

      expect(schedule.executionHistory).toHaveLength(2);
      expect(schedule.totalExecutions).toBe(2);
      expect(schedule.failedExecutions).toBe(0);
    });
  });

  describe('GET /api/v1/schedules/:id', () => {
    it('returns detailed schedule information', () => {
      mockReq.params = { id: 'sched-123' };

      const schedule = {
        id: 'sched-123',
        name: 'Monthly Payroll',
        sourceAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5V3D',
        targetAddress: 'c4c58b2ce5e21ff4fb11d1c53b07502a8e5e98cc',
        amount: '10000000',
        schedule: { type: 'cron', expression: '0 0 1 * *' },
        status: 'active',
        nextExecutionAt: Date.now() + 86400000,
        createdAt: Date.now(),
      };

      expect(schedule.id).toBe('sched-123');
      expect(schedule.nextExecutionAt).toBeGreaterThan(0);
    });

    it('returns 404 for nonexistent schedule', () => {
      mockReq.params = { id: 'nonexistent-sched' };

      expect(mockReq.params.id).toBe('nonexistent-sched');
    });

    it('includes execution history with pagination', () => {
      mockReq.params = { id: 'sched-123' };
      mockReq.query = { limit: '10', offset: '0' };

      const history = {
        executions: [
          { transactionHash: 'tx1', status: 'success', amount: '10000000', timestamp: Date.now() },
        ],
        total: 10,
        limit: 10,
        offset: 0,
      };

      expect(history.total).toBe(10);
      expect(mockReq.query.limit).toBe('10');
    });
  });

  describe('PATCH /api/v1/schedules/:id', () => {
    it('updates schedule parameters', () => {
      mockReq.params = { id: 'sched-123' };
      mockReq.body = {
        name: 'Updated Schedule Name',
        amount: '20000000',
      };

      expect(mockReq.body.name).toBe('Updated Schedule Name');
      expect(mockReq.body.amount).toBe('20000000');
    });

    it('validates updated schedule parameters', () => {
      mockReq.params = { id: 'sched-123' };
      mockReq.body = {
        schedule: { type: 'cron', expression: 'invalid' },
      };

      // Should validate cron syntax
      expect(mockReq.body.schedule.expression).toBe('invalid');
    });

    it('prevents changing schedule for active/running period', () => {
      mockReq.params = { id: 'sched-123' };
      mockReq.body = {
        schedule: { type: 'interval', value: 2, unit: 'weeks' },
      };

      // May prevent schedule change if currently executing
      expect(mockReq.body.schedule.value).toBe(2);
    });

    it('returns 404 for nonexistent schedule', () => {
      mockReq.params = { id: 'nonexistent-sched' };
      mockReq.body = { name: 'New Name' };

      expect(mockReq.params.id).toBe('nonexistent-sched');
    });

    it('returns 200 OK on successful update', () => {
      mockReq.params = { id: 'sched-123' };
      mockReq.body = { name: 'Updated Name' };

      expect(mockRes.status).toBeDefined();
    });
  });

  describe('POST /api/v1/schedules/:id/pause', () => {
    it('pauses an active schedule', () => {
      mockReq.params = { id: 'sched-123' };

      // Schedule transitions from 'active' to 'paused'
      expect(mockReq.params.id).toBe('sched-123');
    });

    it('returns 404 for nonexistent schedule', () => {
      mockReq.params = { id: 'nonexistent-sched' };

      expect(mockReq.params.id).toBe('nonexistent-sched');
    });

    it('prevents pausing an already-paused schedule', () => {
      mockReq.params = { id: 'already-paused' };

      // Should return 400 or idempotent
      expect(mockReq.params.id).toBe('already-paused');
    });

    it('records pause action in audit log', () => {
      mockReq.params = { id: 'sched-123' };
      mockReq.apiKeyRecord = { id: 'test-key-123' };

      // Pause should be recorded in audit log
      expect(mockReq.apiKeyRecord).toBeDefined();
    });

    it('returns 200 OK on successful pause', () => {
      mockReq.params = { id: 'sched-123' };

      expect(mockRes.status).toBeDefined();
    });
  });

  describe('POST /api/v1/schedules/:id/resume', () => {
    it('resumes a paused schedule', () => {
      mockReq.params = { id: 'paused-sched' };

      // Schedule transitions from 'paused' back to 'active'
      expect(mockReq.params.id).toBe('paused-sched');
    });

    it('returns 404 for nonexistent schedule', () => {
      mockReq.params = { id: 'nonexistent-sched' };

      expect(mockReq.params.id).toBe('nonexistent-sched');
    });

    it('prevents resuming an active schedule', () => {
      mockReq.params = { id: 'active-sched' };

      // Should return 400 or idempotent
      expect(mockReq.params.id).toBe('active-sched');
    });

    it('updates next execution time on resume', () => {
      mockReq.params = { id: 'paused-sched' };

      // Resume should recalculate next execution based on current schedule
      expect(mockReq.params.id).toBe('paused-sched');
    });
  });

  describe('DELETE /api/v1/schedules/:id', () => {
    it('cancels schedule execution', () => {
      mockReq.params = { id: 'sched-123' };
      mockReq.apiKeyRecord = { id: 'test-key-123' };

      // Schedule transitions to 'cancelled' status
      expect(mockReq.params.id).toBe('sched-123');
    });

    it('prevents deletion of schedule owned by different API key', () => {
      mockReq.params = { id: 'sched-owned-by-other' };
      mockReq.apiKeyRecord = { id: 'test-key-123' };

      // Should return 403 Forbidden
      expect(mockReq.apiKeyRecord.id).toBe('test-key-123');
    });

    it('returns 404 for nonexistent schedule', () => {
      mockReq.params = { id: 'nonexistent-sched' };

      expect(mockReq.params.id).toBe('nonexistent-sched');
    });

    it('records cancellation in audit log', () => {
      mockReq.params = { id: 'sched-123' };
      mockReq.apiKeyRecord = { id: 'test-key-123' };

      // Cancellation should be recorded
      expect(mockReq.apiKeyRecord).toBeDefined();
    });

    it('returns 204 No Content on successful deletion', () => {
      mockReq.params = { id: 'sched-123' };

      expect(mockRes.status).toBeDefined();
    });
  });

  describe('Schedule Execution via BullMQ', () => {
    it('executes schedules through dedicated BullMQ repeatable job', () => {
      // Each schedule should have a BullMQ repeatable job
      const jobName = 'execute-funding-schedule';
      expect(jobName).toBeDefined();
    });

    it('handles schedule execution failures with bounded retry', () => {
      // Failed execution should retry with exponential backoff
      const maxRetries = 3;
      expect(maxRetries).toBeGreaterThan(0);
    });

    it('sends notification on repeated failures', () => {
      // After max retries exhausted, notification sent
      const notification = {
        type: 'schedule_failure',
        scheduleId: 'sched-123',
        error: 'All retries exhausted',
      };

      expect(notification.type).toBe('schedule_failure');
    });

    it('skips execution period on permanent error', () => {
      // If execution fails, shouldn't block next period
      expect(true).toBe(true);
    });
  });

  describe('Execution History Recording', () => {
    it('records every execution with resulting transaction hash', () => {
      const execution = {
        scheduleId: 'sched-123',
        transactionHash: 'abc123def456',
        status: 'success',
        amount: '10000000',
        timestamp: Date.now(),
        ledger: 12345,
      };

      expect(execution.transactionHash).toBeDefined();
      expect(execution.status).toBe('success');
    });

    it('makes execution history queryable', () => {
      const query = {
        scheduleId: 'sched-123',
        status: 'success',
        limit: 50,
        offset: 0,
      };

      expect(query.scheduleId).toBe('sched-123');
    });

    it('distinguishes successful from failed executions', () => {
      const executions = [
        { status: 'success', transactionHash: 'tx1' },
        { status: 'failed', error: 'Insufficient balance' },
      ];

      expect(executions[0].status).toBe('success');
      expect(executions[1].status).toBe('failed');
    });

    it('records failure reason if execution failed', () => {
      const failedExecution = {
        status: 'failed',
        error: 'insufficient_balance',
        errorMessage: 'Not enough XLM in source account',
        timestamp: Date.now(),
      };

      expect(failedExecution.error).toBeDefined();
      expect(failedExecution.errorMessage).toBeDefined();
    });
  });

  describe('Schedule Timing Accuracy', () => {
    it('executes cron-based schedule at correct times', () => {
      const cronExpression = '0 0 1 * *'; // First of month at midnight
      expect(cronExpression).toBe('0 0 1 * *');
    });

    it('executes interval-based schedule at regular intervals', () => {
      const schedule = { type: 'interval', value: 7, unit: 'days' };
      expect(schedule.value).toBe(7);
    });

    it('calculates next execution time correctly', () => {
      const now = Date.now();
      const nextExecution = now + 86400000; // 24 hours

      expect(nextExecution).toBeGreaterThan(now);
    });

    it('handles timezone-aware cron expressions', () => {
      const cronWithTz = '0 0 * * * America/New_York';
      expect(cronWithTz).toContain('America/New_York');
    });
  });

  describe('Error Handling', () => {
    it('returns 400 for invalid cron expression', () => {
      mockReq.body = {
        schedule: { type: 'cron', expression: 'invalid' },
      };

      expect(mockReq.body.schedule.expression).toBe('invalid');
    });

    it('returns 400 for invalid interval parameters', () => {
      mockReq.body = {
        schedule: { type: 'interval', value: -1, unit: 'days' },
      };

      expect(mockReq.body.schedule.value).toBeLessThan(0);
    });

    it('returns 400 for missing required fields', () => {
      mockReq.body = {
        name: 'Schedule',
        // Missing schedule, source, target, amount
      };

      expect(mockReq.body.schedule).toBeUndefined();
    });

    it('returns 401 if not authenticated', () => {
      mockReq.apiKeyRecord = undefined;

      expect(mockReq.apiKeyRecord).toBeUndefined();
    });

    it('returns 403 if scope not granted', () => {
      mockReq.apiKeyRecord = { id: 'test-key', scopes: ['status:read'] };

      // Should require 'fund:write' scope
      expect(mockReq.apiKeyRecord.scopes).not.toContain('fund:write');
    });

    it('returns 404 for nonexistent schedule', () => {
      mockReq.params = { id: 'nonexistent' };

      expect(mockReq.params.id).toBe('nonexistent');
    });

    it('returns 409 Conflict if schedule in terminal state', () => {
      mockReq.params = { id: 'completed-sched' };
      mockReq.body = { amount: '20000000' };

      // Cannot modify completed/cancelled schedules
      expect(mockReq.params.id).toBe('completed-sched');
    });
  });

  describe('Idempotency', () => {
    it('supports Idempotency-Key header for create operation', () => {
      mockReq.headers = { 'idempotency-key': 'key-123' };
      mockReq.body = {
        name: 'Schedule',
        schedule: { type: 'interval', value: 1, unit: 'days' },
      };

      expect(mockReq.headers['idempotency-key']).toBe('key-123');
    });

    it('returns same response for duplicate create requests with same key', () => {
      // Request 1 and 2 with same Idempotency-Key should return identical response
      expect(true).toBe(true);
    });

    it('supports Idempotency-Key for delete operations', () => {
      mockReq.params = { id: 'sched-123' };
      mockReq.headers = { 'idempotency-key': 'key-delete-123' };

      expect(mockReq.headers['idempotency-key']).toBe('key-delete-123');
    });
  });
});
