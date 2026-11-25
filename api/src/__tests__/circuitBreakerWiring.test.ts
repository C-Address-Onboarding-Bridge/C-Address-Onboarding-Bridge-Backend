import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

process.env.NODE_ENV = 'test';

vi.mock('../config', () => ({
  config: {
    moonpay: { apiKey: 'pk', secretKey: 'sk' },
    transak: { apiKey: 'tk', secretKey: 'ts', environment: 'STAGING' },
    soroban: {
      rpcUrls: [
        'https://rpc.example.com',
        'https://rpc-2.example.com',
        'https://rpc-3.example.com',
      ],
      rpc: { healthCheckIntervalMs: 60_000, failureThreshold: 100, recoveryIntervalMs: 60_000, selectionStrategy: 'round-robin' },
    },
  },
}));
vi.mock('../logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../services/httpAgent', () => ({ applyKeepAliveAgents: vi.fn() }));

import { CircuitBreaker, CircuitOpenError, CircuitState, circuitBreakers } from '../circuit-breaker';
import { moonpayService } from '../services/moonpay';
import { transakService } from '../services/transak';
import { RpcPool } from '../services/rpcPool';
import { errorHandler } from '../middleware/error';

// Default CircuitBreaker failure threshold.
const THRESHOLD = 5;

describe('circuit breakers wrap outbound calls (#685)', () => {
  beforeEach(() => {
    global.fetch = vi.fn();
    circuitBreakers.set('soroban', new CircuitBreaker('soroban'));
  });

  it('opens the moonpay breaker after repeated failures and then fails fast', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ECONNRESET'));
    const params = { baseCurrency: 'usd', baseCurrencyAmount: 100, quoteCurrency: 'xlm' };

    for (let i = 0; i < THRESHOLD; i++) {
      await expect(moonpayService.getBuyQuote(params)).rejects.toThrow('ECONNRESET');
    }

    expect(circuitBreakers.get('moonpay')!.getState()).toBe(CircuitState.OPEN);
    await expect(moonpayService.getBuyQuote(params)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(global.fetch).toHaveBeenCalledTimes(THRESHOLD);
  });

  it('does not count 4xx responses as upstream failures', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 400, statusText: 'Bad Request' });
    const params = { fiatCurrency: 'USD', fiatAmount: 100, cryptoCurrency: 'XLM' };

    for (let i = 0; i < THRESHOLD + 1; i++) {
      await expect(transakService.getBuyQuote(params)).rejects.toThrow('Bad Request');
    }

    expect(circuitBreakers.get('transak')!.getState()).toBe(CircuitState.CLOSED);
  });

  it('routes Soroban RPC calls through the soroban breaker', async () => {
    const pool = new RpcPool();

    for (let i = 0; i < THRESHOLD; i++) {
      const networkError = Object.assign(new Error('rpc down'), { code: 'ECONNRESET' });
      await expect(pool.execute(async () => { throw networkError; })).rejects.toThrow('rpc down');
    }

    expect(circuitBreakers.get('soroban')!.getState()).toBe(CircuitState.OPEN);
    await expect(pool.execute(async () => 'ok')).rejects.toBeInstanceOf(CircuitOpenError);
    pool.destroy();
  });

  it('does not penalize providers or the breaker for repeated account-not-found errors', async () => {
    const pool = new RpcPool();
    const notFound = Object.assign(new Error('Account not found'), { code: -32004 });

    for (let i = 0; i < 10; i++) {
      await expect(pool.execute(async () => { throw notFound; })).rejects.toThrow('Account not found');
    }

    expect(pool.getMetrics().every((provider) => provider.healthy)).toBe(true);
    expect(circuitBreakers.get('soroban')!.getState()).toBe(CircuitState.CLOSED);
    pool.destroy();
  });

  it('maps CircuitOpenError to 503 in the error handler', () => {
    const json = vi.fn();
    const res = { status: vi.fn(() => ({ json })) } as unknown as Response;

    errorHandler(new CircuitOpenError('moonpay'), {} as Request, res, vi.fn() as NextFunction);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: 'service_unavailable' }));
  });

  it('returns an ambiguous submission hash with the retryable response', () => {
    const json = vi.fn();
    const res = { status: vi.fn(() => ({ json })) } as unknown as Response;
    const error = Object.assign(new Error('poll transaction status by hash'), {
      code: 'TRY_AGAIN_LATER',
      hash: 'abc123',
    });

    errorHandler(error, {} as Request, res, vi.fn() as NextFunction);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      error: 'TRY_AGAIN_LATER',
      hash: 'abc123',
    }));
  });
});
