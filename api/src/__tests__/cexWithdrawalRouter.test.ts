import { describe, it, expect, beforeEach } from 'vitest';

import {
  WithdrawalRouter,
  createCexWithdrawalMemo,
  parseCexWithdrawalMemo,
  defaultCexHandlers,
  WithdrawalRequest,
} from '../../../cex/withdrawal-router';

const request: WithdrawalRequest = {
  destinationAddress: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
  asset: 'XLM',
  amount: '10000000',
  network: 'stellar',
};

const cexConfig = { name: 'binance', apiBaseUrl: 'https://api.binance.com' };

describe('WithdrawalRouter', () => {
  let router: WithdrawalRouter;

  beforeEach(() => {
    router = new WithdrawalRouter();
  });

  it('routes a withdrawal to the registered handler', async () => {
    router.registerExchange('binance', cexConfig, defaultCexHandlers.binance);
    const result = await router.routeWithdrawal('binance', request);
    expect(result.success).toBe(true);
    expect(result.withdrawalId).toContain('bin-');
    expect(result.status).toBe('pending');
  });

  it('normalises exchange names to lowercase on register and lookup', async () => {
    router.registerExchange('Binance', cexConfig, defaultCexHandlers.binance);
    const result = await router.routeWithdrawal('BINANCE', request);
    expect(result.success).toBe(true);
  });

  it('throws for an unregistered exchange', async () => {
    await expect(router.routeWithdrawal('unknown', request)).rejects.toThrow('unsupported exchange: unknown');
  });

  it('lists registered exchanges', () => {
    router.registerExchange('binance', cexConfig, defaultCexHandlers.binance);
    router.registerExchange('coinbase', cexConfig, defaultCexHandlers.coinbase);
    expect(router.getSupportedExchanges()).toEqual(['binance', 'coinbase']);
  });

  it('returns an empty list when no exchanges are registered', () => {
    expect(router.getSupportedExchanges()).toEqual([]);
  });
});

describe('defaultCexHandlers', () => {
  it('binance returns a placeholder pending result', async () => {
    const result = await defaultCexHandlers.binance(request, cexConfig);
    expect(result.success).toBe(true);
    expect(result.withdrawalId).toMatch(/^bin-/);
    expect(result.status).toBe('pending');
    expect(result.estimatedCompletion).toBe('5-30 minutes');
  });

  it('coinbase returns a placeholder pending result', async () => {
    const result = await defaultCexHandlers.coinbase(request, cexConfig);
    expect(result.withdrawalId).toMatch(/^cb-/);
    expect(result.status).toBe('pending');
  });

  it('kraken returns a placeholder pending result', async () => {
    const result = await defaultCexHandlers.kraken(request, cexConfig);
    expect(result.withdrawalId).toMatch(/^kr-/);
    expect(result.status).toBe('pending');
  });
});

describe('createCexWithdrawalMemo', () => {
  it('formats the bridge memo with exchange name and address suffix', () => {
    const memo = createCexWithdrawalMemo('CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM', 'binance');
    expect(memo).toBe('bridge:binance:AAAAD2KM');
  });

  it('normalises and truncates non-alphanumeric exchange names', () => {
    const memo = createCexWithdrawalMemo('CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM', 'My-Exchange!');
    expect(memo).toBe('bridge:myexchan:AAAAD2KM');
  });
});

describe('parseCexWithdrawalMemo', () => {
  it('parses a well-formed bridge memo', () => {
    expect(parseCexWithdrawalMemo('bridge:binance:AB12CD34')).toEqual({
      exchangeName: 'binance',
      targetSuffix: 'AB12CD34',
    });
  });

  it('returns an empty object for a malformed memo', () => {
    expect(parseCexWithdrawalMemo('not-a-bridge-memo')).toEqual({});
    expect(parseCexWithdrawalMemo('bridge:onlyonepart')).toEqual({});
    expect(parseCexWithdrawalMemo('wrong:binance:AB12CD34')).toEqual({});
  });
});
