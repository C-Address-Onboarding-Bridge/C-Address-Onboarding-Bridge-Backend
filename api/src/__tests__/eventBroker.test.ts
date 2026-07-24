import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

process.env.NODE_ENV = 'test';

// Hoisted Mocks for Consumer logic assertion
const {
  mockSubmitFundingTransaction,
  mockRecordFundingMetrics,
  mockInvalidateStatusCache,
  mockXadd,
  mockXgroup,
  mockXreadgroup,
  mockXack,
  mockQuit,
  mockConnect,
} = vi.hoisted(() => ({
  mockSubmitFundingTransaction: vi.fn().mockResolvedValue({ status: 'success', hash: 'mock-hash' }),
  mockRecordFundingMetrics: vi.fn(),
  mockInvalidateStatusCache: vi.fn().mockResolvedValue(undefined),
  mockXadd: vi.fn().mockResolvedValue('12345-0'),
  mockXgroup: vi.fn().mockResolvedValue('OK'),
  mockXreadgroup: vi.fn().mockResolvedValue(null),
  mockXack: vi.fn().mockResolvedValue(1),
  mockQuit: vi.fn().mockResolvedValue('OK'),
  mockConnect: vi.fn().mockResolvedValue(undefined),
}));

// Mock DB pool to return null (no real DB)
vi.mock('../services/db', () => ({
  getPool: vi.fn().mockReturnValue(null),
}));

// Mock config
vi.mock('../config', () => ({
  config: {
    redis: {
      url: 'redis://localhost:6379',
    },
    soroban: {
      networkPassphrase: 'Test SDF Network ; September 2015',
      bridgeContractId: 'CC123',
      feeBps: 30,
    },
  },
}));

// Mock Redis client
vi.mock('ioredis', () => {
  return {
    default: vi.fn().mockImplementation(() => {
      return {
        on: vi.fn(),
        xadd: mockXadd,
        xgroup: mockXgroup,
        xreadgroup: mockXreadgroup,
        xack: mockXack,
        quit: mockQuit,
        connect: mockConnect,
      };
    }),
  };
});

// Mock services called by consumers
vi.mock('../services/soroban', () => ({
  sorobanService: {
    submitFundingTransaction: mockSubmitFundingTransaction,
    getTransactionStatus: vi.fn(),
  },
}));

vi.mock('../services/metrics', () => ({
  recordFundingMetrics: mockRecordFundingMetrics,
  setFeeRateBps: vi.fn(),
}));

vi.mock('../routes/status', () => ({
  invalidateStatusCache: mockInvalidateStatusCache,
}));

import { eventBroker } from '../services/eventBroker';
import { transactionMonitor } from '../services/transactionMonitor';
import { analyticsConsumer } from '../services/analyticsConsumer';
import { webhookDispatcher } from '../services/webhookDispatcher';

describe('EventBroker & Consumers Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    eventBroker._clearInMemory();
    transactionMonitor.start();
    analyticsConsumer.start();
    webhookDispatcher.start();
  });

  afterEach(async () => {
    await eventBroker.stopConsuming();
  });

  it('validates event payloads against Zod schemas', async () => {
    const validEvent = {
      type: 'FeeWithdrawn' as const,
      data: {
        amount: '1000',
        to: 'GB...',
        withdrawnAt: Date.now(),
      },
    };
    expect(() => eventBroker.validateEvent(validEvent)).not.toThrow();

    const invalidEvent = {
      type: 'FeeWithdrawn' as const,
      data: {
        amount: 1000 as any,
        to: 'GB...',
        withdrawnAt: 'today' as any,
      },
    };
    expect(() => eventBroker.validateEvent(invalidEvent)).toThrow();
  });

  it('stores events in the in-memory event store', async () => {
    const event = {
      type: 'FeeWithdrawn' as const,
      data: {
        amount: '500',
        to: 'GC...',
        withdrawnAt: Date.now(),
      },
    };

    await eventBroker.publish(event);

    const inMemoryLog = eventBroker._getInMemoryEvents();
    expect(inMemoryLog).toHaveLength(1);
    expect(inMemoryLog[0].event_type).toBe('FeeWithdrawn');
    expect(JSON.parse(inMemoryLog[0].payload).amount).toBe('500');
  });

  it('falls back to synchronous execution when Redis Stream publish fails', async () => {
    mockXadd.mockRejectedValueOnce(new Error('redis connection failure'));

    const event = {
      type: 'FeeWithdrawn' as const,
      data: {
        amount: '250',
        to: 'GD...',
        withdrawnAt: Date.now(),
      },
    };

    const handler = vi.fn();
    eventBroker.subscribe('FeeWithdrawn', handler);

    await eventBroker.publish(event);

    await new Promise((resolve) => setImmediate(resolve));

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ amount: '250', to: 'GD...' })
    );
  });

  it('replays events from the event store', async () => {
    const event1 = {
      type: 'FeeWithdrawn' as const,
      data: { amount: '10', to: 'A', withdrawnAt: Date.now() },
    };
    const event2 = {
      type: 'FeeWithdrawn' as const,
      data: { amount: '20', to: 'B', withdrawnAt: Date.now() },
    };

    await eventBroker.publish(event1);
    await eventBroker.publish(event2);

    const handler = vi.fn();
    eventBroker.subscribe('FeeWithdrawn', handler);

    await eventBroker.replay(1);

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenNthCalledWith(1, expect.objectContaining({ amount: '10' }));
    expect(handler).toHaveBeenNthCalledWith(2, expect.objectContaining({ amount: '20' }));
  });

  it('moves failed events to Dead Letter Queue (DLQ) after 3 retries', async () => {
    const err = new Error('processing error');
    const failingHandler = vi.fn().mockRejectedValue(err);
    eventBroker.subscribe('FeeWithdrawn', failingHandler);

    const mockMsg = [
      [
        'bridge:events',
        [
          [
            '12345-0',
            [
              'eventId', 'uuid-1',
              'type', 'FeeWithdrawn',
              'payload', JSON.stringify({ amount: '100', to: 'X', withdrawnAt: Date.now() }),
            ],
          ],
        ],
      ],
    ];

    mockXreadgroup.mockResolvedValueOnce(mockMsg);

    await eventBroker.startConsuming();
    await new Promise((resolve) => setTimeout(resolve, 1500));

    expect(failingHandler).toHaveBeenCalledTimes(3);

    const dlq = eventBroker._getInMemoryDlq();
    expect(dlq).toHaveLength(1);
    expect(dlq[0].event_type).toBe('FeeWithdrawn');
    expect(dlq[0].error).toBe('processing error');
  });

  describe('Asynchronous Consumers', () => {
    it('TransactionMonitor: publishes FundingCompleted on successful submit', async () => {
      mockSubmitFundingTransaction.mockResolvedValueOnce({ status: 'success', hash: 'tx-hash-success' });

      // Mock FundingRequested event
      const requestEvent = {
        type: 'FundingRequested' as const,
        data: {
          txHash: 'tx-hash-success',
          sourceAddress: 'G_SRC',
          targetAddress: 'C_TAR',
          tokenAddress: 'CC_TOK',
          amount: '10000',
          feeBps: 30,
          signedXdr: 'AAAAg...',
        },
      };

      // Subscribe to FundingCompleted to assert
      const successHandler = vi.fn();
      eventBroker.subscribe('FundingCompleted', successHandler);

      // Publish the request (triggering transaction monitor sync fallback or direct path)
      await eventBroker.publish(requestEvent);

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(mockSubmitFundingTransaction).toHaveBeenCalledWith('AAAAg...');
      expect(successHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          txHash: 'tx-hash-success',
          amount: '10000',
        })
      );
    });

    it('AnalyticsConsumer: records metrics on event receipt', async () => {
      const completedEvent = {
        type: 'FundingCompleted' as const,
        data: {
          txHash: 'hash-completed',
          sourceAddress: 'G_SRC',
          targetAddress: 'C_TAR',
          tokenAddress: 'CC_TOK',
          amount: '8000',
          feeBps: 30,
          fee: '24',
          completedAt: Date.now(),
        },
      };

      await eventBroker.publish(completedEvent);
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(mockRecordFundingMetrics).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'success',
          amountStroops: '8000',
          feeStroops: '24',
        })
      );
    });

    it('WebhookDispatcher: invalidates status cache on WebhookReceived', async () => {
      const webhookEvent = {
        type: 'WebhookReceived' as const,
        data: {
          provider: 'moonpay' as const,
          payload: {
            data: {
              id: 'moonpay-tx-123',
            },
          },
          receivedAt: Date.now(),
        },
      };

      await eventBroker.publish(webhookEvent);
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(mockInvalidateStatusCache).toHaveBeenCalledWith('moonpay-tx-123');
    });
  });
});
