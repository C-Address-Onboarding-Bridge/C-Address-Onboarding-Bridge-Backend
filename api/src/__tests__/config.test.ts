import { describe, it, expect } from 'vitest';
import { parseTrustProxy } from '../config';

describe('parseTrustProxy', () => {
  it('returns false for undefined', () => {
    expect(parseTrustProxy(undefined)).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(parseTrustProxy('')).toBe(false);
  });

  it('returns true for "true"', () => {
    expect(parseTrustProxy('true')).toBe(true);
  });

  it('returns false for "false"', () => {
    expect(parseTrustProxy('false')).toBe(false);
  });

  it('returns a hop count for a numeric string', () => {
    expect(parseTrustProxy('2')).toBe(2);
  });

  it('returns a subnet list for a comma-separated string', () => {
    expect(parseTrustProxy('loopback, 10.0.0.0/8, 192.168.1.0/24')).toEqual([
      'loopback',
      '10.0.0.0/8',
      '192.168.1.0/24',
    ]);
  });

  it('returns a single subnet as a list', () => {
    expect(parseTrustProxy('10.0.0.0/8')).toEqual(['10.0.0.0/8']);
  });
});
