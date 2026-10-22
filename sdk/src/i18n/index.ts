export type {
  SupportedLocale,
  LocaleMetadata,
  MessageKey,
  MessageParams,
  MessageCatalog,
} from './types.js';
export { SUPPORTED_LOCALES, LOCALE_METADATA } from './types.js';

import type { SupportedLocale, MessageCatalog } from './types.js';
import { en } from './en.js';
import { es } from './es.js';
import { zh } from './zh.js';
import { ja } from './ja.js';
import { ko } from './ko.js';
import { fr } from './fr.js';
import { pt } from './pt.js';

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
