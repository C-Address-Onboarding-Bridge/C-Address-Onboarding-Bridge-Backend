import { describe, it } from 'vitest';
import * as fc from 'fast-check';
import { calculateFee, calculateReceiveAmount, formatTokenAmount, parseTokenAmount } from '../src/utils';

// Arbitrary for valid bigint amounts (0 to MAX_I128)
const MAX_I128 = (BigInt(1) << BigInt(127)) - BigInt(1);
const amountArb = fc.bigInt({ min: BigInt(0), max: MAX_I128 });

// Valid fee rates: 0–10000 bps (0%–100%)
const feeBpsArb = fc.integer({ min: 0, max: 10000 });

describe('Fee calculation properties', () => {
  it('zero fee rate produces zero fee', () => {
    fc.assert(
      fc.property(amountArb, (amount) => {
        return calculateFee(amount, 0) === BigInt(0);
      }),
    );
  });

  it('max fee rate (10000 bps) produces fee equal to full amount', () => {
    fc.assert(
      fc.property(amountArb, (amount) => {
        return calculateFee(amount, 10000) === amount;
      }),
    );
  });

  it('fee is monotonically non-decreasing as amount increases', () => {
    fc.assert(
      fc.property(amountArb, amountArb, feeBpsArb, (a, b, bps) => {
        const lo = a < b ? a : b;
        const hi = a < b ? b : a;
        return calculateFee(lo, bps) <= calculateFee(hi, bps);
      }),
    );
  });

  it('fee is monotonically non-decreasing as fee rate increases', () => {
    fc.assert(
      fc.property(
        amountArb,
        fc.integer({ min: 0, max: 9999 }),
        (amount, bpsLo) => {
          const bpsHi = bpsLo + 1;
          return calculateFee(amount, bpsLo) <= calculateFee(amount, bpsHi);
        },
      ),
    );
  });

  it('fee never exceeds amount (net receive is non-negative)', () => {
    fc.assert(
      fc.property(amountArb, feeBpsArb, (amount, bps) => {
        const fee = calculateFee(amount, bps);
        return fee <= amount && calculateReceiveAmount(amount, bps) >= BigInt(0);
      }),
    );
  });

  it('receive amount plus fee equals original amount', () => {
    fc.assert(
      fc.property(amountArb, feeBpsArb, (amount, bps) => {
        const fee = calculateFee(amount, bps);
        const received = calculateReceiveAmount(amount, bps);
        return received + fee === amount;
      }),
    );
  });

  it('zero amount always produces zero fee and zero receive', () => {
    fc.assert(
      fc.property(feeBpsArb, (bps) => {
        return calculateFee(BigInt(0), bps) === BigInt(0) && calculateReceiveAmount(BigInt(0), bps) === BigInt(0);
      }),
    );
  });

  it('integer overflow never occurs for any valid input', () => {
    fc.assert(
      fc.property(amountArb, feeBpsArb, (amount, bps) => {
        let threw = false;
        try {
          const fee = calculateFee(amount, bps);
          calculateReceiveAmount(amount, bps);
          // Result must still be a bigint in range
          if (typeof fee !== 'bigint' || fee < BigInt(0)) threw = true;
        } catch {
          threw = true;
        }
        return !threw;
      }),
    );
  });

  it('fee at zero amount with any rate is zero', () => {
    fc.assert(
      fc.property(feeBpsArb, (bps) => calculateFee(BigInt(0), bps) === BigInt(0)),
    );
  });
});


describe('Token amount formatting properties', () => {
  const decimalArb = fc.integer({ min: 0, max: 18 });

  it('parseTokenAmount is inverse of formatTokenAmount for non-negative amounts', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: BigInt(0), max: BigInt('999999999999999999') }),
        decimalArb,
        (rawAmount, decimals) => {
          const amountStr = rawAmount.toString();
          const formatted = formatTokenAmount(amountStr, decimals);
          const reparsed = parseTokenAmount(formatted, decimals);
          return reparsed === amountStr;
        },
      ),
    );
  });

    it('formatTokenAmount always produces a string with exactly N fractional digits', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 20 }).map(s => s.replace(/[^0-9]/g, '') || '0'),
        decimalArb,
        (amountStr, decimals) => {
          const formatted = formatTokenAmount(amountStr, decimals);
          if (decimals === 0) {
            return !formatted.includes('.') && /^\d+$/.test(formatted);
          }
          const parts = formatted.split('.');
          return parts.length === 2 && parts[1].length === decimals;
        },
      ),
    );
  });

    it('parseTokenAmount always produces a valid integer string', () => {
    fc.assert(
      fc.property(
        fc.float({ min: 0, max: Math.fround(1e12), noNaN: true }).map(n => n.toFixed(6)),
        decimalArb,
        (amountStr, decimals) => {
          const parsed = parseTokenAmount(amountStr, decimals);
          return /^\d+$/.test(parsed);
        },
      ),
    );
  });
});
