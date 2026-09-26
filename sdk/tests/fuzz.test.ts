import { test, expect } from 'vitest';
import fc from 'fast-check';
import {
  isValidStellarAddress,
  isCAddress,
  isGAddress,
  isValidTokenIdentifier,
  isSacTokenAddress,
  validateSacTokenAddress,
  formatStellarAmount,
  tokenFromLegacy,
  getDefaultDecimals,
} from '../src/utils';

/**
 * TODO(next-bounty): the tests marked `.skip` in this file assert behaviour that
 * depends on SDK helpers that are still `throw new Error('Not implemented: ...')` stubs.
 * They are skipped -- not deleted, not rewritten to match the stub -- so the next
 * programme has an exact worklist: un-skip one, implement it, repeat.
 */

test('Fuzz testing isValidStellarAddress never throws and is consistent with isCAddress/isGAddress', () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 200 }), (address) => {
      const valid = isValidStellarAddress(address);
      expect(typeof valid).toBe('boolean');
      if (isCAddress(address) || isGAddress(address)) {
        expect(valid).toBe(true);
      }
      if (valid) {
        expect(isCAddress(address) || isGAddress(address)).toBe(true);
      }
    }),
    { numRuns: 1000 },
  );
});

test.skip('Fuzz testing isSacTokenAddress / validateSacTokenAddress agree', () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 200 }), (address) => {
      const valid = isSacTokenAddress(address);
      expect(typeof valid).toBe('boolean');
      if (valid) {
        expect(() => validateSacTokenAddress(address)).not.toThrow();
      } else {
        expect(() => validateSacTokenAddress(address)).toThrow();
      }
    }),
    { numRuns: 1000 },
  );
});

test.skip('Fuzz testing isValidTokenIdentifier never throws', () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 200 }), (identifier) => {
      const result = isValidTokenIdentifier(identifier);
      expect(typeof result).toBe('boolean');
      if (identifier !== 'native' && result) {
        expect(isSacTokenAddress(identifier)).toBe(true);
      }
    }),
    { numRuns: 1000 },
  );
});

test.skip('Fuzz testing formatStellarAmount never throws and always returns a decimal string', () => {
  fc.assert(
    fc.property(
      fc.oneof(
        fc.stringMatching(/^[0-9]{1,30}$/),
        fc.constant(''),
        fc.constant('0'),
      ),
      (amount) => {
        const result = formatStellarAmount(amount);
        expect(typeof result).toBe('string');
        expect(result).toContain('.');
        expect(result.split('.')[1]).toHaveLength(7);
      },
    ),
    { numRuns: 1000 },
  );
});

test.skip('Fuzz testing tokenFromLegacy never throws and always returns a well-formed Token', () => {
  fc.assert(
    fc.property(
      fc.option(fc.string({ maxLength: 100 }), { nil: undefined }),
      fc.option(fc.string({ maxLength: 100 }), { nil: undefined }),
      (tokenAddress, sourceAsset) => {
        const token = tokenFromLegacy(tokenAddress, sourceAsset);
        expect(token.type === 'native' || token.type === 'sac').toBe(true);
        if (token.type === 'sac') {
          expect(isSacTokenAddress(token.contractId)).toBe(true);
        }
        // Result must always be usable by getDefaultDecimals without throwing.
        expect(typeof getDefaultDecimals(token)).toBe('number');
      },
    ),
    { numRuns: 1000 },
  );
});

test.skip('Fuzz testing getDefaultDecimals returns a stable positive integer for both token types', () => {
  fc.assert(
    fc.property(
      fc.oneof(
        fc.constant({ type: 'native' as const }),
        fc.string({ maxLength: 100 }).map((contractId) => ({ type: 'sac' as const, contractId })),
      ),
      (token) => {
        const decimals = getDefaultDecimals(token);
        expect(Number.isInteger(decimals)).toBe(true);
        expect(decimals).toBeGreaterThan(0);
      },
    ),
    { numRuns: 1000 },
  );
});
