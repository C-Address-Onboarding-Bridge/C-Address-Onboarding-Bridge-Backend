import { describe, it, expect } from 'vitest';
import { parseTokenAmount, formatTokenAmount } from '../src/token';
import { ValidationError } from '../src/errors';

describe('parseTokenAmount', () => {
  describe('valid inputs', () => {
    it.each([
      { input: '1.5', decimals: 6, expected: '1500000' },
      { input: '1.5', decimals: 7, expected: '15000000' },
      { input: '0.001', decimals: 6, expected: '1000' },
      { input: '2', decimals: 6, expected: '2000000' },
      { input: '0', decimals: 7, expected: '0' },
      { input: '0.0', decimals: 7, expected: '0' },
      { input: '0.0000000', decimals: 7, expected: '0' },
      { input: '100', decimals: 0, expected: '100' },
      { input: '0.1234567', decimals: 7, expected: '1234567' },
      { input: '-1.5', decimals: 6, expected: '-1500000' },
      { input: '-0', decimals: 6, expected: '0' },
    ])('correctly parses "$input" with $decimals decimals -> "$expected"', ({ input, decimals, expected }) => {
      expect(parseTokenAmount(input, decimals)).toBe(expected);
    });
  });

  describe('table tests for malformed inputs (#876)', () => {
    it.each([
      { input: '1.2.3', decimals: 7, description: 'multiple decimal points' },
      { input: 'abc', decimals: 7, description: 'non-numeric characters' },
      { input: '1e5', decimals: 7, description: 'scientific notation' },
      { input: '.5', decimals: 7, description: 'missing leading integer part' },
      { input: ' 1', decimals: 7, description: 'leading whitespace' },
      { input: '1 ', decimals: 7, description: 'trailing whitespace' },
      { input: '1..0', decimals: 7, description: 'double decimal points' },
      { input: '1,000', decimals: 7, description: 'comma-separated digits' },
      { input: '', decimals: 7, description: 'empty string' },
      { input: '--5', decimals: 7, description: 'double minus signs' },
    ])('rejects "$input" ($description) with ValidationError containing fields.amount', ({ input, decimals }) => {
      try {
        parseTokenAmount(input, decimals);
        expect.unreachable(`Expected parseTokenAmount to throw for input: ${input}`);
      } catch (err) {
        expect(err).toBeInstanceOf(ValidationError);
        expect((err as ValidationError).fields).toBeDefined();
        expect((err as ValidationError).fields?.amount).toBeDefined();
      }
    });
  });

  describe('table tests for excessive decimal precision (#876)', () => {
    it.each([
      { input: '1.123456789', decimals: 7, description: '9 decimals provided for 7-decimal token' },
      { input: '0.1234567', decimals: 6, description: '7 decimals provided for 6-decimal token' },
      { input: '10.5', decimals: 0, description: 'fractional part provided for 0-decimal token' },
      { input: '1.000000001', decimals: 8, description: '9 decimals provided for 8-decimal token' },
    ])('throws ValidationError for "$input" ($description) when precision exceeds $decimals', ({ input, decimals }) => {
      expect(() => parseTokenAmount(input, decimals)).toThrow(ValidationError);
      try {
        parseTokenAmount(input, decimals);
      } catch (err) {
        expect(err).toBeInstanceOf(ValidationError);
        expect((err as ValidationError).fields?.amount).toMatch(/decimal places/i);
      }
    });
  });
});
