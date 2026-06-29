import { test, expect } from 'vitest';
import fc from 'fast-check';
import { OnboardingClient } from '../src/client';
import { formatAmount, calculateFee, validateAddress, constructUrl } from '../src/utils';

test('Fuzz testing formatAmount', () => {
  fc.assert(
    fc.property(
      fc.oneof(fc.integer(), fc.float(), fc.maxSafeInteger(), fc.double(), fc.string(), fc.constant(NaN), fc.constant(Infinity), fc.constant(-Infinity)),
      (amount) => {
        try {
          const result = formatAmount(amount as any);
          expect(typeof result).toBe('string');
        } catch (e) {
          // Expect standard error objects, no crashes
          expect(e).toBeInstanceOf(Error);
        }
      }
    ),
    { numRuns: 1000 }
  );
});

test('Fuzz testing calculateFee', () => {
  fc.assert(
    fc.property(
      fc.double({ noNaN: false, noDefaultInfinity: false }), 
      fc.double({ noNaN: false, noDefaultInfinity: false }),
      (amount, rate) => {
        try {
          const fee = calculateFee(amount, rate);
          expect(typeof fee).toBe('number');
        } catch (e) {
          expect(e).toBeInstanceOf(Error);
        }
      }
    ),
    { numRuns: 1000 }
  );
});

test('Fuzz testing validateAddress', () => {
  fc.assert(
    fc.property(
      fc.string({ maxLength: 1000 }),
      (address) => {
        try {
          const isValid = validateAddress(address);
          expect(typeof isValid).toBe('boolean');
        } catch (e) {
          expect(e).toBeInstanceOf(Error);
        }
      }
    ),
    { numRuns: 1000 }
  );
});

test('Fuzz testing constructUrl', () => {
  fc.assert(
    fc.property(
      fc.string(), fc.dictionary(fc.string(), fc.string()),
      (baseUrl, params) => {
        try {
          const url = constructUrl(baseUrl, params);
          expect(typeof url).toBe('string');
        } catch (e) {
          expect(e).toBeInstanceOf(Error);
        }
      }
    ),
    { numRuns: 1000 }
  );
});
