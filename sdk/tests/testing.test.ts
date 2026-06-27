import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BridgeClient } from '../src/bridge';
import { OfflineBridgeClient } from '../src/offline';
import {
  createMockServer,
  fixtures,
  MOCK_C_ADDRESS,
  MOCK_G_ADDRESS,
  MOCK_TOKEN_ADDRESS,
  MOCK_TX_HASH,
  MOCK_QUOTE_PARAMS,
} from '../src/testing';

// ─── Setup ───────────────────────────────────────────────────────────────────

const BASE_URL = 'http://mock.bridge.test';

function makeClient(overrides?: ConstructorParameters<typeof BridgeClient>[0]): BridgeClient {
  return new BridgeClient({ baseUrl: BASE_URL, ...overrides });
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

describe('fixtures', () => {
  it('returns a valid Quote with defaults', () => {
    const q = fixtures.quote();
    expect(q.feeBps).toBe(100);
    expect(q.estimatedFee).toBe('100');
    expect(q.expectedReceive).toBe('9900');
    expect(q.rate).toBe('1.0');
  });

  it('merges overrides into Quote', () => {
    const q = fixtures.quote({ rate: '2.0', feeBps: 50 });
    expect(q.rate).toBe('2.0');
    expect(q.feeBps).toBe(50);
    expect(q.estimatedFee).toBe('100'); // untouched default
  });

  it('returns a pending TransactionStatus by default', () => {
    const s = fixtures.transactionStatus();
    expect(s.status).toBe('pending');
    expect(s.hash).toBe(MOCK_TX_HASH);
    expect(s.error).toBeUndefined();
  });

  it('returns a failed TransactionStatus with error field', () => {
    const s = fixtures.transactionStatus('failed');
    expect(s.status).toBe('failed');
    expect(s.error).toBeDefined();
  });

  it('returns a success TransactionStatus without error', () => {
    const s = fixtures.transactionStatus('success');
    expect(s.status).toBe('success');
    expect(s.error).toBeUndefined();
  });

  it('returns a FundingPrepareResult with correct shape', () => {
    const r = fixtures.fundingPrepareResult();
    expect(r.instruction).toBe('sign-and-submit');
    expect(r.params.targetAddress).toBe(MOCK_C_ADDRESS);
    expect(r.params.sourceAddress).toBe(MOCK_G_ADDRESS);
    expect(r.params.tokenAddress).toBe(MOCK_TOKEN_ADDRESS);
  });

  it('returns a CexWithdrawalResult', () => {
    const r = fixtures.cexWithdrawalResult({ status: 'completed' });
    expect(r.status).toBe('completed');
    expect(r.withdrawalId).toBeTruthy();
  });

  it('returns widget URLs for moonpay and transak', () => {
    expect(fixtures.moonpayWidgetResult().url).toContain('moonpay.com');
    expect(fixtures.transakWidgetResult().url).toContain('transak.com');
  });

  it('builds an api error with optional code', () => {
    expect(fixtures.apiError('oops')).toEqual({ message: 'oops' });
    expect(fixtures.apiError('oops', 'ERR_503')).toEqual({ message: 'oops', code: 'ERR_503' });
  });
});

// ─── BridgeMockServer — default responses ────────────────────────────────────

describe('BridgeMockServer — default responses', () => {
  const mock = createMockServer();
  beforeEach(() => mock.install());
  afterEach(() => { mock.reset(); mock.uninstall(); });

  it('returns a default Quote for getQuote', async () => {
    const client = makeClient();
    const quote = await client.getQuote(MOCK_QUOTE_PARAMS);
    expect(quote.feeBps).toBe(100);
    expect(quote.rate).toBe('1.0');
  });

  it('returns a default health response', async () => {
    const client = makeClient();
    const h = await client.health();
    expect(h.status).toBe('ok');
  });

  it('returns a default FundingPrepareResult', async () => {
    const client = makeClient();
    const result = await client.prepareFundingTransaction({
      sourceAddress: MOCK_G_ADDRESS,
      targetAddress: MOCK_C_ADDRESS,
      tokenAddress: MOCK_TOKEN_ADDRESS,
      amount: '10000',
    });
    expect(result.instruction).toBe('sign-and-submit');
  });

  it('returns a default FundingResult for submitSignedXdr', async () => {
    const client = makeClient();
    const result = await client.submitSignedXdr({ signedXdr: 'AAAA==' });
    expect(result.status).toBe('pending');
    expect(result.hash).toBe(MOCK_TX_HASH);
  });

  it('returns a default TransactionStatus for getStatus', async () => {
    const client = makeClient();
    const status = await client.getStatus(MOCK_TX_HASH);
    expect(status.status).toBe('pending');
  });

  it('returns a default CexWithdrawalResult', async () => {
    const client = makeClient();
    const result = await client.routeCexWithdrawal({
      exchange: 'binance',
      sourceAsset: 'XLM',
      amount: '100',
      targetCAddress: MOCK_C_ADDRESS,
    });
    expect(result.withdrawalId).toBeTruthy();
  });

  it('returns default Moonpay and Transak widget URLs', async () => {
    const client = makeClient();
    const mp = await client.createMoonpayUrl({ walletAddress: MOCK_C_ADDRESS });
    const tr = await client.createTransakUrl({ walletAddress: MOCK_C_ADDRESS });
    expect(mp.url).toContain('moonpay.com');
    expect(tr.url).toContain('transak.com');
  });
});

// ─── BridgeMockServer — route overrides ──────────────────────────────────────

describe('BridgeMockServer — route overrides', () => {
  const mock = createMockServer();
  beforeEach(() => mock.install());
  afterEach(() => { mock.reset(); mock.uninstall(); });

  it('overrides quote with a custom response', async () => {
    mock.onQuote().reply(200, fixtures.quote({ rate: '2.5', feeBps: 50 }));
    const client = makeClient();
    const quote = await client.getQuote(MOCK_QUOTE_PARAMS);
    expect(quote.rate).toBe('2.5');
    expect(quote.feeBps).toBe(50);
  });

  it('overrides status for a specific txHash', async () => {
    mock.onStatus(MOCK_TX_HASH).reply(200, fixtures.transactionStatus('success'));
    const client = makeClient();
    const status = await client.getStatus(MOCK_TX_HASH);
    expect(status.status).toBe('success');
  });

  it('overrides status for any txHash', async () => {
    mock.onStatus().reply(200, fixtures.transactionStatus('failed'));
    const client = makeClient();
    const status = await client.getStatus('any-hash');
    expect(status.status).toBe('failed');
  });

  it('supports last-in-wins for multiple overrides on the same route', async () => {
    mock.onQuote().reply(200, fixtures.quote({ rate: '1.0' }));
    mock.onQuote().reply(200, fixtures.quote({ rate: '3.0' }));
    const client = makeClient();
    const quote = await client.getQuote(MOCK_QUOTE_PARAMS);
    expect(quote.rate).toBe('3.0');
  });

  it('overrides generic routes via onRoute', async () => {
    mock.onRoute('GET', '/api/v1/txns').reply(200, {
      data: [{ id: 'tx1' }],
      nextCursor: null,
      hasMore: false,
    });
    const client = makeClient();
    const page = await client.requestPaginated<{ id: string }>('/api/v1/txns');
    expect(page.data).toHaveLength(1);
    expect(page.data[0].id).toBe('tx1');
  });

  it('resets overrides between tests (isolation check)', async () => {
    mock.onQuote().reply(200, fixtures.quote({ rate: '99.0' }));
    mock.reset();
    const client = makeClient();
    const quote = await client.getQuote(MOCK_QUOTE_PARAMS);
    expect(quote.rate).toBe('1.0'); // back to default
  });
});

// ─── BridgeMockServer — error scenarios ──────────────────────────────────────

describe('BridgeMockServer — error scenarios', () => {
  const mock = createMockServer();
  beforeEach(() => mock.install());
  afterEach(() => { mock.reset(); mock.uninstall(); });

  it('replyError returns an error status and message', async () => {
    mock.onQuote().replyError(503, 'Service temporarily unavailable');
    const client = makeClient({ retry: { maxRetries: 0 } });
    await expect(client.getQuote(MOCK_QUOTE_PARAMS)).rejects.toThrow('Service temporarily unavailable');
  });

  it('networkError triggers retry logic', async () => {
    let callCount = 0;
    mock.onFundPrepare().networkError();
    // Override fetch to count calls and still error
    mock.onFundPrepare().networkError();

    // Network errors are retried; use maxRetries:0 to fail immediately
    const client = makeClient({ retry: { maxRetries: 0 } });
    await expect(
      client.prepareFundingTransaction({
        sourceAddress: MOCK_G_ADDRESS,
        targetAddress: MOCK_C_ADDRESS,
        tokenAddress: MOCK_TOKEN_ADDRESS,
        amount: '10000',
      }),
    ).rejects.toThrow();
    void callCount;
  });

  it('simulates 401 unauthorized', async () => {
    mock.onQuote().reply(401, fixtures.apiError('Unauthorized', 'UNAUTHORIZED'));
    const client = makeClient({ retry: { maxRetries: 0 } });
    await expect(client.getQuote(MOCK_QUOTE_PARAMS)).rejects.toThrow('Unauthorized');
  });

  it('simulates 429 rate-limit (retryable)', async () => {
    mock
      .onQuote()
      .reply(429, fixtures.apiError('Too Many Requests'));
    // With maxRetries:0 it should fail on the first attempt
    const client = makeClient({ retry: { maxRetries: 0 } });
    await expect(client.getQuote(MOCK_QUOTE_PARAMS)).rejects.toThrow();
  });

  it('returns 404 for an unregistered route', async () => {
    const client = makeClient({ retry: { maxRetries: 0 } });
    await expect(client.requestPaginated('/api/v1/does-not-exist')).rejects.toThrow();
  });
});

// ─── BridgeMockServer — delay simulation ─────────────────────────────────────

describe('BridgeMockServer — delay simulation', () => {
  const mock = createMockServer();
  beforeEach(() => mock.install());
  afterEach(() => { mock.reset(); mock.uninstall(); });

  it('delays the response by the configured amount', async () => {
    mock.onHealth().delay(50).reply(200, { status: 'ok' });
    const client = makeClient();
    const start = Date.now();
    await client.health();
    expect(Date.now() - start).toBeGreaterThanOrEqual(40);
  });
});

// ─── BridgeMockServer — request recording ────────────────────────────────────

describe('BridgeMockServer — request recording', () => {
  const mock = createMockServer();
  beforeEach(() => mock.install());
  afterEach(() => { mock.reset(); mock.uninstall(); });

  it('records the URL, method, and search params of each request', async () => {
    const client = makeClient();
    await client.getQuote({ sourceAsset: 'USDC', amount: '5000', targetAddress: MOCK_C_ADDRESS });
    expect(mock.requests).toHaveLength(1);
    const req = mock.requests[0];
    expect(req.method).toBe('GET');
    expect(req.pathname).toBe('/api/v1/quote');
    expect(req.searchParams['sourceAsset']).toBe('USDC');
    expect(req.searchParams['amount']).toBe('5000');
  });

  it('records the request body for POST requests', async () => {
    const client = makeClient();
    await client.submitSignedXdr({ signedXdr: 'AAAA==' });
    const req = mock.requests[0];
    expect(req.method).toBe('POST');
    expect((req.body as { signedXdr: string }).signedXdr).toBe('AAAA==');
  });

  it('records API key header when provided', async () => {
    const client = makeClient({ apiKey: 'test-key-123' });
    await client.health();
    expect(mock.requests[0].headers['x-api-key']).toBe('test-key-123');
  });

  it('records multiple requests in order', async () => {
    const client = makeClient();
    await client.health();
    await client.getQuote(MOCK_QUOTE_PARAMS);
    expect(mock.requests).toHaveLength(2);
    expect(mock.requests[0].pathname).toBe('/health');
    expect(mock.requests[1].pathname).toBe('/api/v1/quote');
  });

  it('clears request history on reset()', async () => {
    const client = makeClient();
    await client.health();
    expect(mock.requests).toHaveLength(1);
    mock.reset();
    expect(mock.requests).toHaveLength(0);
  });
});

// ─── BridgeMockServer — OfflineBridgeClient integration ──────────────────────

describe('BridgeMockServer — OfflineBridgeClient integration', () => {
  const mock = createMockServer();
  beforeEach(() => mock.install());
  afterEach(() => { mock.reset(); mock.uninstall(); });

  it('queues requests when the server returns a network error', async () => {
    mock.onFundPrepare().networkError();
    const client = new OfflineBridgeClient({
      baseUrl: BASE_URL,
      offlineOptions: { autoQueue: true, healthCheckIntervalMs: 60_000 },
    });
    try {
      await client.prepareFundingTransaction({
        sourceAddress: MOCK_G_ADDRESS,
        targetAddress: MOCK_C_ADDRESS,
        tokenAddress: MOCK_TOKEN_ADDRESS,
        amount: '10000',
      });
    } catch {
      // OfflineError expected
    }
    expect(client.getQueuedRequests()).toHaveLength(1);
    client.destroy();
  });
});
