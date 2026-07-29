import { describe, it, expect } from 'vitest';
import {
  SUPPORTED_LOCALES,
  LOCALE_METADATA,
  MESSAGE_CATALOGS,
  en,
} from '../src/i18n';
import type { MessageKey, MessageCatalog } from '../src/i18n/types';

/** Canonical set of message keys, derived from the baseline `en` catalog. */
const CANONICAL_KEYS = Object.keys(en) as MessageKey[];

/** Extracts `{{param}}` placeholder names from a template string. */
function placeholdersOf(template: string): string[] {
  const matches = template.match(/{{\s*[\w.]+\s*}}/g) ?? [];
  return matches.map((m) => m.replace(/[{}]/g, '').trim()).sort();
}

describe('i18n: SUPPORTED_LOCALES / LOCALE_METADATA', () => {
  it('has metadata for every supported locale', () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(LOCALE_METADATA[locale]).toBeDefined();
      expect(LOCALE_METADATA[locale].nativeName).toBeTruthy();
      expect(LOCALE_METADATA[locale].language).toBeTruthy();
      expect(['ltr', 'rtl']).toContain(LOCALE_METADATA[locale].dir);
    }
  });

  it('has no metadata entries for unsupported locales', () => {
    expect(Object.keys(LOCALE_METADATA).sort()).toEqual([...SUPPORTED_LOCALES].sort());
  });
});

describe('i18n: MESSAGE_CATALOGS registry', () => {
  it('has a catalog for every supported locale', () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(MESSAGE_CATALOGS[locale]).toBeDefined();
    }
  });

  it('has no catalogs for unsupported locales', () => {
    expect(Object.keys(MESSAGE_CATALOGS).sort()).toEqual([...SUPPORTED_LOCALES].sort());
  });
});

describe.each(SUPPORTED_LOCALES)('i18n catalog: %s', (locale) => {
  const catalog: MessageCatalog = MESSAGE_CATALOGS[locale];

  it('defines every MessageKey with no missing keys', () => {
    const missing = CANONICAL_KEYS.filter((key) => !(key in catalog));
    expect(missing).toEqual([]);
  });

  it('defines no keys beyond MessageKey', () => {
    const extra = Object.keys(catalog).filter((key) => !CANONICAL_KEYS.includes(key as MessageKey));
    expect(extra).toEqual([]);
  });

  it('has exactly the canonical key count', () => {
    expect(Object.keys(catalog)).toHaveLength(CANONICAL_KEYS.length);
  });

  it('maps every key to a non-empty string', () => {
    for (const key of CANONICAL_KEYS) {
      expect(typeof catalog[key]).toBe('string');
      expect(catalog[key].length).toBeGreaterThan(0);
    }
  });

  it('preserves the same {{param}} placeholders as the en baseline', () => {
    for (const key of CANONICAL_KEYS) {
      expect(placeholdersOf(catalog[key])).toEqual(placeholdersOf(en[key]));
    }
  });
});

describe('i18n: en baseline sanity', () => {
  it('covers every declared MessageKey (canonical source of truth)', () => {
    expect(CANONICAL_KEYS.length).toBeGreaterThan(0);
    expect(new Set(CANONICAL_KEYS).size).toBe(CANONICAL_KEYS.length);
  });
});
