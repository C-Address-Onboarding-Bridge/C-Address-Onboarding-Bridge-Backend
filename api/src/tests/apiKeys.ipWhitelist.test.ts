import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { validateIpOrCidr } from '../middleware/rbacAuth.js';

const ipEntrySchema = z
  .string()
  .refine(validateIpOrCidr, { message: 'Invalid IP address or CIDR' });

const ipWhitelistSchema = z.array(ipEntrySchema);

describe('ipWhitelist validation', () => {
  it('accepts a valid IPv4 address', () => {
    expect(() => ipWhitelistSchema.parse(['10.0.0.1'])).not.toThrow();
  });

  it('accepts a valid IPv4 CIDR', () => {
    expect(() => ipWhitelistSchema.parse(['192.168.0.0/24'])).not.toThrow();
  });

  it('accepts a valid IPv6 CIDR', () => {
    expect(() => ipWhitelistSchema.parse(['2001:db8::/32'])).not.toThrow();
  });

  it('rejects an invalid CIDR prefix', () => {
    expect(() => ipWhitelistSchema.parse(['10.0.0.0/33'])).toThrow();
  });

  it('rejects an out-of-range IPv4 octet', () => {
    expect(() => ipWhitelistSchema.parse(['999.1.1.1'])).toThrow();
  });

  it('rejects a plain hostname', () => {
    expect(() => ipWhitelistSchema.parse(['office'])).toThrow();
  });
});
