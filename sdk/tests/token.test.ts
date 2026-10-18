import { describe, expect, it } from 'vitest';
import { isSacTokenAddress } from '../src/token';

describe('isSacTokenAddress', () => {
  it('accepts a valid contract StrKey', () => {
    expect(
      isSacTokenAddress('CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4'),
    ).toBe(true);
  });

  it('rejects a contract StrKey with a bad checksum', () => {
    expect(
      isSacTokenAddress('CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC5'),
    ).toBe(false);
  });

  it('rejects a G-address', () => {
    expect(
      isSacTokenAddress('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'),
    ).toBe(false);
  });
});
