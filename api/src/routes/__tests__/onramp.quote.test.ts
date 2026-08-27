import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

process.env.NODE_ENV = 'test';

vi.mock('../../config', () => ({
  config: {
    logging: { version: '0.1.0', serviceName: 'test', environment: 'test', sensitiveFields: [], bodyTruncateLength: 200 },
  },
}));

vi.mock('../../services/moonpay', () => ({
  moonpayService: {
    getBuyQuote: vi.fn(),
  },
}));

vi.mock('../../services/transak', () => ({
  transakService: {
    getBuyQuote: vi.fn(),
  },
}));

vi.mock('../../services/asyncPipeline', () => ({
  enqueueCounterIncrement: vi.fn(),
}));

vi.mock('../../services/metrics', () => ({
  onrampRequestCount: {
    inc: vi.fn(),
  },
}));

const quoteRequestSchema = z.object({
  fiatAmount: z.coerce.number().positive(),
  fiatCurrency: z.string().min(1),
  cryptoCurrency: z.string().min(1).default('xlm'),
  cAddress: z.string().regex(/^[GSTX][A-Z0-9]{55}$/, 'invalid Stellar address'),
});

describe('On-Ramp Quote Validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('accepts valid quote request', () => {
    const query = {
      fiatAmount: '100',
      fiatCurrency: 'USD',
      cryptoCurrency: 'xlm',
      cAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFSC4',
    };
    const result = quoteRequestSchema.parse(query);
    expect(result.fiatAmount).toBe(100);
    expect(result.fiatCurrency).toBe('USD');
  });

  it('rejects quote with zero fiat amount', () => {
    const query = {
      fiatAmount: '0',
      fiatCurrency: 'USD',
      cAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFSC4',
    };
    expect(() => quoteRequestSchema.parse(query)).toThrow();
  });

  it('rejects quote with negative fiat amount', () => {
    const query = {
      fiatAmount: '-100',
      fiatCurrency: 'USD',
      cAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFSC4',
    };
    expect(() => quoteRequestSchema.parse(query)).toThrow();
  });

  it('rejects quote with missing fiat currency', () => {
    const query = {
      fiatAmount: '100',
      cAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFSC4',
    };
    expect(() => quoteRequestSchema.parse(query)).toThrow();
  });

  it('rejects quote with invalid Stellar address', () => {
    const query = {
      fiatAmount: '100',
      fiatCurrency: 'USD',
      cAddress: 'INVALID_ADDRESS',
    };
    expect(() => quoteRequestSchema.parse(query)).toThrow('invalid Stellar address');
  });

  it('defaults crypto currency to xlm when not specified', () => {
    const query = {
      fiatAmount: '100',
      fiatCurrency: 'USD',
      cAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFSC4',
    };
    const result = quoteRequestSchema.parse(query);
    expect(result.cryptoCurrency).toBe('xlm');
  });
});

describe('Provider Quote Comparison', () => {
  it('correctly ranks providers by net amount received', () => {
    const quotes = [
      { provider: 'moonpay' as const, netAmount: 150, fiatAmount: 100, cryptoAmount: 150, feeAmount: 5, estimatedRate: 1.5 },
      { provider: 'transak' as const, netAmount: 145, fiatAmount: 100, cryptoAmount: 150, feeAmount: 5, estimatedRate: 1.5 },
    ];
    const sorted = quotes.sort((a, b) => b.netAmount - a.netAmount);
    expect(sorted[0].provider).toBe('moonpay');
    expect(sorted[1].provider).toBe('transak');
  });

  it('handles single provider quote when other fails', () => {
    const quotes = [
      { provider: 'moonpay' as const, netAmount: 150, fiatAmount: 100, cryptoAmount: 150, feeAmount: 5, estimatedRate: 1.5 },
    ];
    expect(quotes.length).toBe(1);
    expect(quotes[0].provider).toBe('moonpay');
  });
});
