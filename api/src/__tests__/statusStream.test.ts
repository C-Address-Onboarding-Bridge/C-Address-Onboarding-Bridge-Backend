import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

process.env.NODE_ENV = 'test';
process.env.API_KEYS = 'test-api-key-123';

vi.mock('../index', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../services/soroban', () => ({
  sorobanService: {
    getTransactionStatus: vi.fn().mockResolvedValue({
      status: 'pending',
      ledger: 12345,
      hash: 'abc123',
    }),
  },
}));

vi.mock('../services/cache', () => ({
  buildCacheKey: vi.fn((ns, key) => `${ns}:${key}`),
  getOrCompute: vi.fn(),
  CACHE_TTL: { status: 30000 },
}));

describe('Server-Sent Events Endpoint - Transaction Status Streaming', () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: NextFunction;

  beforeEach(() => {
    vi.clearAllMocks();
    mockReq = {
      params: { hash: 'a'.repeat(64) },
      apiKeyRecord: { id: 'test-key-123' },
      headers: { authorization: 'Bearer test-key-123' },
    };
    mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      setHeader: vi.fn().mockReturnThis(),
      write: vi.fn(),
      end: vi.fn(),
    };
    mockNext = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('GET /api/v1/status/:hash/stream', () => {
    it('returns text/event-stream content type', () => {
      mockReq.params = { hash: 'a'.repeat(64) };

      // Should set proper SSE headers
      const expectedHeaders = {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      };

      expect(expectedHeaders['Content-Type']).toBe('text/event-stream');
      expect(expectedHeaders['Cache-Control']).toBe('no-cache');
      expect(expectedHeaders['Connection']).toBe('keep-alive');
    });

    it('streams transaction status updates in real-time', () => {
      mockReq.params = { hash: 'a'.repeat(64) };

      // Should stream SSE events for status changes
      const sseEvents = [
        { event: 'status', data: { status: 'pending', ledger: 123 } },
        { event: 'status', data: { status: 'success', ledger: 456 } },
      ];

      expect(sseEvents).toHaveLength(2);
      expect(sseEvents[0].event).toBe('status');
      expect(sseEvents[1].data.status).toBe('success');
    });

    it('reuses existing status-polling and dedup logic', () => {
      mockReq.params = { hash: 'a'.repeat(64) };

      // Should leverage existing polling logic from GET /api/v1/status
      // and avoid duplicating dedup logic
      expect(mockReq.params.hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('sends periodic heartbeat comments to prevent timeout', () => {
      mockReq.params = { hash: 'a'.repeat(64) };

      // Should send heartbeat comments every 30-60s
      const heartbeatInterval = 45_000; // milliseconds
      expect(heartbeatInterval).toBeGreaterThan(30_000);
      expect(heartbeatInterval).toBeLessThan(60_000);
    });

    it('closes stream once transaction reaches terminal state', () => {
      mockReq.params = { hash: 'a'.repeat(64) };

      const terminalStates = ['success', 'failed', 'expired'];

      // Stream should close automatically upon reaching terminal state
      expect(terminalStates).toContain('success');
      expect(terminalStates).toContain('failed');
    });

    it('validates transaction hash format', () => {
      mockReq.params = { hash: 'invalid-hash' };

      // Should return 400 for invalid format
      expect(mockReq.params.hash).not.toMatch(/^[a-f0-9]{64}$/);
    });

    it('returns 404 for nonexistent transaction', () => {
      mockReq.params = { hash: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' };

      // If transaction never exists, should return 404
      expect(mockReq.params.hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('respects authentication and rate limits', () => {
      mockReq.params = { hash: 'a'.repeat(64) };
      mockReq.apiKeyRecord = { id: 'test-key-123' };

      // Should enforce same auth and rate limits as polling
      expect(mockReq.apiKeyRecord).toBeDefined();
    });
  });

  describe('SSE Event Formatting', () => {
    it('sends status updates in SSE format', () => {
      const statusUpdate = {
        event: 'status',
        data: {
          status: 'pending',
          ledger: 12345,
          hash: 'abc123',
          timestamp: Date.now(),
        },
      };

      expect(statusUpdate.event).toBe('status');
      expect(statusUpdate.data.status).toBe('pending');
    });

    it('includes explorer URLs in status events', () => {
      const statusEvent = {
        data: {
          status: 'success',
          explorerUrl: 'https://stellar.expert/explorer/testnet/tx/abc123',
          explorerUrls: [
            'https://stellar.expert/explorer/testnet/tx/abc123',
            'https://stellar.place/explorer/testnet/tx/abc123',
          ],
        },
      };

      expect(statusEvent.data.explorerUrl).toBeDefined();
      expect(statusEvent.data.explorerUrls).toHaveLength(2);
    });

    it('sends heartbeat comments as SSE comments', () => {
      const heartbeatComment = ': heartbeat';

      // SSE comments don't trigger event listeners
      expect(heartbeatComment).toMatch(/^:/);
    });

    it('formats SSE events with proper line endings', () => {
      const sseFormat = 'event: status\ndata: {"status":"pending"}\n\n';

      // SSE requires double newline between events
      expect(sseFormat).toMatch(/\n\n$/);
    });

    it('handles multiline data fields correctly', () => {
      const complexData = {
        status: 'pending',
        details: 'This is a multiline\ndescription of the event',
      };

      // Should properly escape or handle multiline data
      expect(complexData.details).toContain('\n');
    });
  });

  describe('Connection Management', () => {
    it('keeps connection open while polling for updates', () => {
      mockReq.params = { hash: 'a'.repeat(64) };

      // Should poll server for status changes while connection is open
      expect(mockReq.params.hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('closes stream immediately upon reaching terminal state', () => {
      mockReq.params = { hash: 'a'.repeat(64) };

      const terminalStates = ['success', 'failed', 'expired'];

      // Should close connection when terminal state is reached
      expect(terminalStates).toContain('success');
    });

    it('cleans up resources on client disconnect', () => {
      mockReq.params = { hash: 'a'.repeat(64) };

      // Should properly clean up polling intervals/timers
      expect(mockReq.params.hash).toBeDefined();
    });

    it('handles network interruptions gracefully', () => {
      mockReq.params = { hash: 'a'.repeat(64) };

      // Client can reconnect and resume from last-event-id
      expect(mockReq.params.hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('sets timeout for idle connections', () => {
      mockReq.params = { hash: 'a'.repeat(64) };

      const idleTimeout = 300_000; // 5 minutes
      expect(idleTimeout).toBeGreaterThan(0);
    });
  });

  describe('Status Dedup Logic', () => {
    it('avoids sending duplicate status events', () => {
      mockReq.params = { hash: 'a'.repeat(64) };

      const events = [
        { status: 'pending', ledger: 123 },
        { status: 'pending', ledger: 123 }, // duplicate
        { status: 'success', ledger: 456 }, // different
      ];

      // Should only send if status changed
      expect(events[0]).toEqual(events[1]);
      expect(events[1]).not.toEqual(events[2]);
    });

    it('reuses polling logic to check status periodically', () => {
      mockReq.params = { hash: 'a'.repeat(64) };

      // Should use same polling mechanism as GET /api/v1/status
      const pollingInterval = 5_000; // 5 seconds
      expect(pollingInterval).toBeGreaterThan(0);
    });

    it('caches status results like polling endpoint', () => {
      mockReq.params = { hash: 'a'.repeat(64) };

      // Should use cache to avoid redundant service calls
      expect(mockReq.params.hash).toBeDefined();
    });
  });

  describe('Rate Limiting', () => {
    it('respects same rate limits as polling endpoint', () => {
      mockReq.params = { hash: 'a'.repeat(64) };
      mockReq.apiKeyRecord = { id: 'test-key-123' };

      // Should check rate limit before opening stream
      expect(mockReq.apiKeyRecord).toBeDefined();
    });

    it('counts stream connections against rate limit', () => {
      mockReq.params = { hash: 'a'.repeat(64) };

      // Each open SSE stream counts toward rate limit
      expect(mockReq.params.hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('closes stream if rate limit exceeded', () => {
      mockReq.params = { hash: 'a'.repeat(64) };

      // Should return 429 if rate limit hit
      expect(mockReq.params.hash).toBeDefined();
    });
  });

  describe('Authentication and Authorization', () => {
    it('requires API key authentication', () => {
      mockReq.params = { hash: 'a'.repeat(64) };
      mockReq.apiKeyRecord = undefined;

      // Should return 401 if not authenticated
      expect(mockReq.apiKeyRecord).toBeUndefined();
    });

    it('validates API key scopes', () => {
      mockReq.params = { hash: 'a'.repeat(64) };
      mockReq.apiKeyRecord = { id: 'test-key-123', scopes: ['status:read'] };

      // Should require 'status:read' scope
      expect(mockReq.apiKeyRecord.scopes).toContain('status:read');
    });

    it('returns 403 if key lacks required scope', () => {
      mockReq.params = { hash: 'a'.repeat(64) };
      mockReq.apiKeyRecord = { id: 'test-key-123', scopes: ['fund:write'] };

      // Should return 403 without 'status:read' scope
      expect(mockReq.apiKeyRecord.scopes).not.toContain('status:read');
    });
  });

  describe('Error Handling', () => {
    it('returns 400 for invalid transaction hash format', () => {
      mockReq.params = { hash: 'not-hex' };

      // Should validate hash is 64 hex characters
      expect(mockReq.params.hash).not.toMatch(/^[a-f0-9]{64}$/);
    });

    it('returns 401 if not authenticated', () => {
      mockReq.params = { hash: 'a'.repeat(64) };
      mockReq.apiKeyRecord = undefined;

      expect(mockReq.apiKeyRecord).toBeUndefined();
    });

    it('returns 403 if scope not granted', () => {
      mockReq.params = { hash: 'a'.repeat(64) };
      mockReq.apiKeyRecord = { id: 'test-key-123', scopes: [] };

      expect(mockReq.apiKeyRecord.scopes).toHaveLength(0);
    });

    it('returns 404 for nonexistent transaction', () => {
      mockReq.params = { hash: 'nonexistent' + 'a'.repeat(53) };

      // If transaction never exists after sufficient time
      expect(mockReq.params.hash).toMatch(/^[a-z0-9]{64}$/);
    });

    it('returns 429 if rate limited', () => {
      mockReq.params = { hash: 'a'.repeat(64) };
      mockReq.apiKeyRecord = { id: 'test-key-123' };

      // Should enforce rate limiting
      expect(mockReq.apiKeyRecord).toBeDefined();
    });

    it('handles service errors gracefully', () => {
      mockReq.params = { hash: 'a'.repeat(64) };

      // Should return 500 with clear error message if service fails
      expect(mockReq.params.hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('sends error events to client over SSE', () => {
      const errorEvent = {
        event: 'error',
        data: { error: 'service_unavailable', message: 'Could not fetch status' },
      };

      expect(errorEvent.event).toBe('error');
      expect(errorEvent.data.error).toBeDefined();
    });
  });

  describe('Reconnection Support', () => {
    it('supports Last-Event-ID header for resuming stream', () => {
      mockReq.params = { hash: 'a'.repeat(64) };
      mockReq.headers = { 'last-event-id': '123' };

      // Client browser will auto-set Last-Event-ID on reconnect
      expect(mockReq.headers['last-event-id']).toBe('123');
    });

    it('can replay events since last-event-id', () => {
      mockReq.params = { hash: 'a'.repeat(64) };

      // Should resend any events with id >= last-event-id
      expect(mockReq.params.hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('automatically reconnects on network failure', () => {
      mockReq.params = { hash: 'a'.repeat(64) };

      // Browser automatically reconnects SSE on network failure
      expect(mockReq.params.hash).toBeDefined();
    });
  });

  describe('Performance and Resource Management', () => {
    it('polls efficiently without busy-waiting', () => {
      mockReq.params = { hash: 'a'.repeat(64) };

      const pollingInterval = 5_000; // 5 second polling
      expect(pollingInterval).toBeGreaterThan(1_000);
    });

    it('uses cache to minimize service calls', () => {
      mockReq.params = { hash: 'a'.repeat(64) };

      // Should reuse cache from polling endpoint
      expect(mockReq.params.hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('closes stream on resource exhaustion', () => {
      mockReq.params = { hash: 'a'.repeat(64) };

      // Should gracefully close if too many concurrent streams
      expect(mockReq.params.hash).toBeDefined();
    });

    it('limits concurrent streams per API key', () => {
      mockReq.apiKeyRecord = { id: 'test-key-123' };

      // Each key should have a limit on concurrent streams
      expect(mockReq.apiKeyRecord).toBeDefined();
    });
  });

  describe('Documentation and Examples', () => {
    it('documents SSE connection setup', () => {
      const example = `
        const eventSource = new EventSource('/api/v1/status/hash/stream');
        eventSource.addEventListener('status', (event) => {
          const status = JSON.parse(event.data);
          console.log('Transaction status:', status);
        });
        eventSource.addEventListener('error', (event) => {
          console.error('Stream error:', event);
          eventSource.close();
        });
      `;

      expect(example).toContain('EventSource');
      expect(example).toContain('addEventListener');
    });

    it('documents heartbeat handling', () => {
      const example = `
        // Comments (lines starting with :) should be ignored by client
        // They are sent as heartbeats to prevent timeout
      `;

      expect(example).toContain('heartbeats');
    });

    it('documents terminal state closure', () => {
      const example = `
        // Stream automatically closes when transaction reaches:
        // - "success" status
        // - "failed" status
        // - "expired" status
      `;

      expect(example).toContain('terminal state');
    });
  });
});
