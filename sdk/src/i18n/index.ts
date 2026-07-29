import type { MessageCatalog, MessageKey, MessageParams, SupportedLocale } from './types';
import { en } from './en';
import { es } from './es';
import { zh } from './zh';
import { ja } from './ja';
import { ko } from './ko';
import { fr } from './fr';
import { pt } from './pt';

export * from './types';
export { en, es, zh, ja, ko, fr, pt };

/** All message catalogs, keyed by locale. */
export const CATALOGS: Record<SupportedLocale, MessageCatalog> = {
  en,
  es,
  zh,
  ja,
  ko,
  fr,
  pt,
};

/** Locale used when no locale is specified, or a requested locale isn't found. */
export const DEFAULT_LOCALE: SupportedLocale = 'en';

/** Returns the message catalog for `locale`, falling back to {@link DEFAULT_LOCALE}. */
export function getCatalog(locale?: SupportedLocale): MessageCatalog {
  return (locale && CATALOGS[locale]) || CATALOGS[DEFAULT_LOCALE];
}

type ParamsArg<K extends MessageKey> = MessageParams[K] extends Record<string, never>
  ? [params?: undefined]
  : [params: MessageParams[K]];

/**
 * Resolves `key` in `locale`'s catalog (falling back to {@link DEFAULT_LOCALE} for the
 * locale itself, and to the raw template if the key is somehow missing) and interpolates
 * any `{{param}}` placeholders using `params`.
 */
export function translate<K extends MessageKey>(
  locale: SupportedLocale | undefined,
  key: K,
  ...[params]: ParamsArg<K>
): string {
  const template = getCatalog(locale)[key] ?? CATALOGS[DEFAULT_LOCALE][key];
  const values = (params ?? {}) as Record<string, string | number>;
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match,
  );
}

/** Shorthand alias for {@link translate}. */
export const t = translate;
