import { describe, it, expect } from 'vitest';
import { en } from '../src/i18n/en';
import { es } from '../src/i18n/es';
import { zh } from '../src/i18n/zh';
import type { MessageKey, MessageCatalog } from '../src/i18n/types';
import { SUPPORTED_LOCALES } from '../src/i18n/types';

// Map locale code → catalog for completeness checks
const catalogs: Record<string, MessageCatalog> = { en, es, zh };

describe('i18n catalog completeness', () => {
  /** Extract all MessageKey union members from the type system.
   *  Since we can't iterate a union at runtime, we verify each catalog
   *  against the known list of keys derived from the base (en) catalog,
   *  which is the source of truth for keys. */
  const expectedKeys = Object.keys(en) as MessageKey[];

  it('en catalog has all MessageKey entries (self-consistency)', () => {
    expect(expectedKeys.length).toBeGreaterThan(0);
    // en is the baseline — every key must have a non-empty string value
    for (const key of expectedKeys) {
      expect(typeof en[key]).toBe('string');
      expect((en[key] as string).length).toBeGreaterThan(0);
    }
  });

  it('all three existing catalogs have the same keys', () => {
    const enKeys = Object.keys(en).sort();
    for (const [locale, catalog] of Object.entries(catalogs)) {
      const catalogKeys = Object.keys(catalog).sort();
      expect(catalogKeys).toEqual(enKeys);
    }
  });

  it('no catalog has extra keys beyond en', () => {
    const enKeySet = new Set(Object.keys(en));
    for (const [locale, catalog] of Object.entries(catalogs)) {
      const extraKeys = Object.keys(catalog).filter(k => !enKeySet.has(k));
      expect(extraKeys).toEqual([]);
    }
  });

  it('every message value is a non-empty string', () => {
    for (const [locale, catalog] of Object.entries(catalogs)) {
      for (const [key, value] of Object.entries(catalog)) {
        expect(typeof value).toBe('string');
        expect((value as string).length).toBeGreaterThan(0);
      }
    }
  });

  // Verify that missing locale catalogs (ja, ko, fr, pt) are listed in SUPPORTED_LOCALES
  // but lack actual catalog files — this is the gap discovered via this test
  it('SUPPORTED_LOCALES lists locales that lack catalog files', () => {
    const implementedLocales = Object.keys(catalogs);
    const missing = SUPPORTED_LOCALES.filter(l => !implementedLocales.includes(l));
    // ja, ko, fr, pt are declared but not implemented — this test documents the gap
    expect(missing.sort()).toEqual(['fr', 'ja', 'ko', 'pt']);
  });
});

describe('i18n param interpolation (future-proof)', () => {
  /** Basic mustache-style interpolation validator.
   *  The translate function is not yet implemented, but catalogs already
   *  use {{param}} syntax — this test ensures the patterns are consistent. */
  const PARAM_RE = /\{\{\s*(\w+)\s*\}\}/g;

  it('all catalog entries with params use consistent {{param}} syntax', () => {
    for (const [locale, catalog] of Object.entries(catalogs)) {
      for (const [key, value] of Object.entries(catalog)) {
        const params = Array.from((value as string).matchAll(PARAM_RE), m => m[1]);
        // If there are params, they should be valid identifiers
        for (const param of params) {
          expect(param).toMatch(/^[a-zA-Z_]\w*$/);
        }
      }
    }
  });

  it('en catalog param placeholders match expected keys', () => {
    // Known keys with params and their expected parameters
    const paramKeys: Record<string, string[]> = {
      'error.request_failed': ['status'],
      'error.validation.invalid_address': ['address'],
      'error.validation.invalid_amount': ['amount'],
      'error.validation.missing_field': ['field'],
      'error.validation.generic': ['detail'],
      'error.rate_limit.retry_after': ['seconds'],
      'error.timeout': ['operation', 'ms'],
      'error.queue_full': ['max'],
      'error.invalid_stellar_address': ['address'],
      'error.invalid_c_address': ['address'],
      'error.invalid_g_address': ['address'],
      'error.fee_too_high': ['feeBps', 'maxBps'],
      'error.amount_too_small': ['amount', 'min'],
      'error.amount_too_large': ['amount', 'max'],
      'error.unsupported_exchange': ['exchange'],
    };

    for (const [key, expectedParams] of Object.entries(paramKeys)) {
      const template = en[key];
      expect(template).toBeDefined();
      const actualParams = Array.from((template as string).matchAll(PARAM_RE), m => m[1]);
      expect(actualParams.sort()).toEqual(expectedParams.sort());
    }
  });

  it('keys without params have no {{}} in their template', () => {
    const paramlessKeys = Object.keys(en).filter(k => !(k in {
      'error.request_failed': true,
      'error.validation.invalid_address': true,
      'error.validation.invalid_amount': true,
      'error.validation.missing_field': true,
      'error.validation.generic': true,
      'error.rate_limit.retry_after': true,
      'error.timeout': true,
      'error.queue_full': true,
      'error.invalid_stellar_address': true,
      'error.invalid_c_address': true,
      'error.invalid_g_address': true,
      'error.fee_too_high': true,
      'error.amount_too_small': true,
      'error.amount_too_large': true,
      'error.unsupported_exchange': true,
    }));

    for (const key of paramlessKeys) {
      const template = en[key] as string;
      expect(PARAM_RE.test(template)).toBe(false);
    }
  });
});
