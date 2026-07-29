export type {
  SupportedLocale,
  LocaleMetadata,
  MessageKey,
  MessageParams,
  MessageCatalog,
} from './types';
export { SUPPORTED_LOCALES, LOCALE_METADATA } from './types';

import type { SupportedLocale, MessageCatalog } from './types';
import { en } from './en';
import { es } from './es';
import { zh } from './zh';
import { ja } from './ja';
import { ko } from './ko';
import { fr } from './fr';
import { pt } from './pt';

export { en, es, zh, ja, ko, fr, pt };

/** All message catalogs keyed by supported locale. */
export const MESSAGE_CATALOGS: Record<SupportedLocale, MessageCatalog> = {
  en,
  es,
  zh,
  ja,
  ko,
  fr,
  pt,
};
