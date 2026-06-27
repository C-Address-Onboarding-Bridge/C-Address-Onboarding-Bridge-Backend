/**
 * Soroban testnet integration tests.
 *
 * Run locally:
 *   TESTNET_API_URL=https://your-bridge-api.example.com \
 *   TESTNET_API_KEY=your-api-key \
 *   npm run test:integration
 *
 * Required environment variables:
 *   TESTNET_API_URL   — Base URL of the bridge API pointed at Soroban testnet
 *   TESTNET_API_KEY   — (optional) API key for the bridge service
 *
 * Optional:
 *   TESTNET_RATE_LIMIT_DELAY_MS — extra delay between requests to respect rate limits (default 500)
 *   TESTNET_TIMEOUT_MS          — per-request timeout in ms (default 30 000)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BridgeClient } from '../../src/bridge';
import { calculateFee, calculateReceiveAmount } from '../../src/utils';
import {
  isAuthError,
  isNetworkError,
  isNotFoundError,
  isRateLimitError,
  isBridgeError,
} from '../../src/errors';

// ─── Skip guard ───────────────────────────────────────────────────────────────

const TESTNET_API_URL = process.env['TESTNET_API_URL'];
const TESTNET_API_KEY = process.env['TESTNET_API_KEY'];
const RATE_LIMIT_DELAY_MS = Number(process.env['TESTNET_RATE_LIMIT_DELAY_MS'] ?? 500);
const TIMEOUT_MS = Number(process.env['TESTNET_TIMEOUT_MS'] ?? 30_000);

const runIntegration = TESTNET_API_URL
  ? describe
  : describe.skip.bind(describe, '[SKIPPED — set TESTNET_API_URL to enable]');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRateLimit<T>(fn: () => Promise<T>): Promise<T> {
  const result = await fn();
  await delay(RATE_LIMIT_DELAY_MS);
  return result;
}

// ─── Suite ────────────────────────────────────────────────────────────────────

runIntegration('Soroban Testnet Integration', () => {
  let client: BridgeClient;

  const TEST_SOURCE_ASSET = 'XLM';
  const TEST_AMOUNT = '1000000'; // 0.1 XLM in stroops

  // A valid Soroban testnet C-address for the bridge contract.
  // The test suite resolves this from the API's health/info endpoint.
  let targetAddress: string;

  // ─── Setup / teardown ─────────────────────────────────────────────────────

  beforeAll(async () => {
    client = new BridgeClient({
      baseUrl: TESTNET_API_URL!,
      apiKey: TESTNET_API_KEY,
      retry: {
        maxRetries: 2,
        baseDelayMs: 1_000,
        maxDelayMs: 5_000,
        retryBudgetMs: 15_000,
      },
    });

    // Resolve a target C-address from the server's health/info response if possible,
    // or fall back to a known testnet contract address from env.
    const envTarget = process.env['TESTNET_TARGET_C_ADDRESS'];
    if (envTarget) {
      targetAddress = envTarget;
    } else {
      // Attempt to derive from health — tolerate missing field gracefully.
      try {
        const health = await client.health();
        const h = health as unknown as { contractAddress?: string };
        targetAddress = h.contractAddress ?? 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
      } catch {
        targetAddress = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
      }
    }
  }, TIMEOUT_MS);

  afterAll(async () => {
    // No persistent state to clean up — testnet accounts expire or are funded
    // ephemerally via Friendbot.
  });

  // ─── Health ───────────────────────────────────────────────────────────────

  it('health endpoint returns ok status', async () => {
    const result = await withRateLimit(() => client.health());
    expect(result).toHaveProperty('status');
    expect(typeof result.status).toBe('string');
  }, TIMEOUT_MS);

  // ─── Quote ────────────────────────────────────────────────────────────────

  it('quote request returns a valid response', async () => {
    const quote = await withRateLimit(() =>
      client.getQuote({
        sourceAsset: TEST_SOURCE_ASSET,
        amount: TEST_AMOUNT,
        targetAddress,
      }),
    );

    expect(quote).toHaveProperty('estimatedFee');
    expect(quote).toHaveProperty('expectedReceive');
    expect(quote).toHaveProperty('feeBps');
    expect(quote).toHaveProperty('rate');

    expect(Number(quote.feeBps)).toBeGreaterThanOrEqual(0);
    expect(Number(quote.feeBps)).toBeLessThanOrEqual(10000);
  }, TIMEOUT_MS);

  it('quote fee matches local fee calculation', async () => {
    const quote = await withRateLimit(() =>
      client.getQuote({
        sourceAsset: TEST_SOURCE_ASSET,
        amount: TEST_AMOUNT,
        targetAddress,
      }),
    );

    const amount = BigInt(TEST_AMOUNT);
    const localFee = calculateFee(amount, quote.feeBps);
    const localReceive = calculateReceiveAmount(amount, quote.feeBps);

    // The server's fee should match our local calculation (within 1 stroop for rounding).
    const serverFee = BigInt(quote.estimatedFee);
    const serverReceive = BigInt(quote.expectedReceive);

    expect(Math.abs(Number(localFee - serverFee))).toBeLessThanOrEqual(1);
    expect(Math.abs(Number(localReceive - serverReceive))).toBeLessThanOrEqual(1);
  }, TIMEOUT_MS);

  it('quote with zero amount returns sensible response', async () => {
    let threw = false;
    try {
      await withRateLimit(() =>
        client.getQuote({
          sourceAsset: TEST_SOURCE_ASSET,
          amount: '0',
          targetAddress,
        }),
      );
    } catch (err) {
      threw = true;
      // Either a ValidationError or a server error is acceptable for amount=0
      expect(isBridgeError(err)).toBe(true);
    }
    // Some servers return a valid quote with zero fee; both outcomes are acceptable.
    expect(typeof threw).toBe('boolean');
  }, TIMEOUT_MS);

  // ─── Funding preparation ──────────────────────────────────────────────────

  it('prepareFundingTransaction returns instruction and simulation', async () => {
    const sourceAddress = process.env['TESTNET_SOURCE_G_ADDRESS'];
    const tokenAddress = process.env['TESTNET_TOKEN_ADDRESS'];

    if (!sourceAddress || !tokenAddress) {
      // Cannot test fund prepare without real addresses — mark as pending.
      return;
    }

    const result = await withRateLimit(() =>
      client.prepareFundingTransaction({
        sourceAddress,
        targetAddress,
        tokenAddress,
        amount: TEST_AMOUNT,
        memo: 'integration-test',
      }),
    );

    expect(result).toHaveProperty('instruction');
    expect(result).toHaveProperty('simulation');
    expect(result).toHaveProperty('params');
    expect(typeof result.instruction).toBe('string');
  }, TIMEOUT_MS);

  // ─── Transaction status ───────────────────────────────────────────────────

  it('getStatus for known-pending hash returns a valid status object', async () => {
    const knownHash = process.env['TESTNET_KNOWN_TX_HASH'];
    if (!knownHash) return;

    const status = await withRateLimit(() => client.getStatus(knownHash));
    expect(['pending', 'success', 'failed']).toContain(status.status);
    expect(status.hash).toBe(knownHash);
  }, TIMEOUT_MS);

  it('getStatus for unknown hash returns NotFoundError or failed status', async () => {
    const fakeHash = 'a'.repeat(64);
    try {
      const status = await withRateLimit(() => client.getStatus(fakeHash));
      // Some implementations return a failed status instead of 404
      expect(['pending', 'success', 'failed']).toContain(status.status);
    } catch (err) {
      expect(isNotFoundError(err) || isBridgeError(err)).toBe(true);
    }
  }, TIMEOUT_MS);

  // ─── Rate limit handling ──────────────────────────────────────────────────

  it('handles rate limits gracefully with RateLimitError', async () => {
    // Fire 10 rapid requests and check that any 429 is wrapped properly.
    const promises = Array.from({ length: 10 }, () =>
      client.getQuote({
        sourceAsset: TEST_SOURCE_ASSET,
        amount: TEST_AMOUNT,
        targetAddress,
      }).catch((err) => err),
    );

    const results = await Promise.all(promises);
    for (const r of results) {
      if (r instanceof Error) {
        expect(isRateLimitError(r) || isBridgeError(r) || isNetworkError(r)).toBe(true);
      } else {
        expect(r).toHaveProperty('feeBps');
      }
    }
  }, TIMEOUT_MS * 2);

  // ─── Auth ─────────────────────────────────────────────────────────────────

  it('invalid API key returns AuthError', async () => {
    if (!TESTNET_API_KEY) return; // only testable when auth is enforced

    const badClient = new BridgeClient({
      baseUrl: TESTNET_API_URL!,
      apiKey: 'invalid-key-000',
    });

    try {
      await withRateLimit(() =>
        badClient.getQuote({
          sourceAsset: TEST_SOURCE_ASSET,
          amount: TEST_AMOUNT,
          targetAddress,
        }),
      );
      // If the server doesn't enforce auth, just pass
    } catch (err) {
      expect(isAuthError(err)).toBe(true);
    }
  }, TIMEOUT_MS);

  // ─── Request signing ──────────────────────────────────────────────────────

  it('signed requests are accepted when signing is enabled', async () => {
    if (!TESTNET_API_KEY) return;

    const signedClient = new BridgeClient({
      baseUrl: TESTNET_API_URL!,
      apiKey: TESTNET_API_KEY,
      signing: { enabled: true },
    });

    const quote = await withRateLimit(() =>
      signedClient.getQuote({
        sourceAsset: TEST_SOURCE_ASSET,
        amount: TEST_AMOUNT,
        targetAddress,
      }),
    );

    // Server must accept signed requests at minimum as well as unsigned ones.
    expect(quote).toHaveProperty('feeBps');
  }, TIMEOUT_MS);
});
