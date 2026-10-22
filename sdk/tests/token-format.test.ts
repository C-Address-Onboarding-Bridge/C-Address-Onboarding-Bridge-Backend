import { describe, expect, it } from 'vitest';
import { formatTokenAmount } from '../src/token';

describe('formatTokenAmount validation and edge cases', () => {
  it('formats zero with the requested number of decimal places', () => {
    expect(formatTokenAmount('0', 0)).toBe('0');
    expect(formatTokenAmount('0', 3)).toBe('0.000');
  });

  it('formats signed amounts without padding before the sign', () => {
    expect(formatTokenAmount('-5', 3)).toBe('-0.005');
    expect(formatTokenAmount('-5', 0)).toBe('-5');
  });

  it('rejects non-integer amount strings', () => {
    expect(() => formatTokenAmount('1.2', 2)).toThrow(/integer string/);
    expect(() => formatTokenAmount('', 2)).toThrow(/integer string/);
    expect(() => formatTokenAmount('--1', 2)).toThrow(/integer string/);
  });

  it('rejects invalid decimal counts', () => {
    expect(() => formatTokenAmount('1', -1)).toThrow(/non-negative integer/);
    expect(() => formatTokenAmount('1', 1.5)).toThrow(/non-negative integer/);
  });
});
