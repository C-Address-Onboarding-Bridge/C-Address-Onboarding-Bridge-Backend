// ─── Locale identifiers ────────────────────────────────────────────────────────

/** BCP-47 locale tags supported out of the box. */
export type SupportedLocale = 'en' | 'es' | 'zh' | 'ja' | 'ko' | 'fr' | 'pt';

export const SUPPORTED_LOCALES: readonly SupportedLocale[] = [
  'en',
  'es',
  'zh',
  'ja',
  'ko',
  'fr',
  'pt',
] as const;

/** Per-locale metadata used by tooling and UI consumers. */
export interface LocaleMetadata {
  /** Human-readable name in the locale's own language. */
  nativeName: string;
  /** ISO 639-1 language code. */
  language: string;
  /** Text direction — important for UI consumers. */
  dir: 'ltr' | 'rtl';
}

export const LOCALE_METADATA: Record<SupportedLocale, LocaleMetadata> = {
  en: { nativeName: 'English',    language: 'en', dir: 'ltr' },
  es: { nativeName: 'Español',    language: 'es', dir: 'ltr' },
  zh: { nativeName: '中文',        language: 'zh', dir: 'ltr' },
  ja: { nativeName: '日本語',      language: 'ja', dir: 'ltr' },
  ko: { nativeName: '한국어',      language: 'ko', dir: 'ltr' },
  fr: { nativeName: 'Français',   language: 'fr', dir: 'ltr' },
  pt: { nativeName: 'Português',  language: 'pt', dir: 'ltr' },
};

// ─── Message catalog types ─────────────────────────────────────────────────────

/**
 * All user-facing message keys.  Each key maps to a template string that may
 * contain `{{param}}` placeholders.  The `MessageParams` type below enforces
 * which params are required for each key.
 */
export type MessageKey =
  // Generic / base
  | 'error.unknown'
  | 'error.request_failed'
  // Auth
  | 'error.auth.unauthorized'
  | 'error.auth.forbidden'
  // Validation
  | 'error.validation.invalid_address'
  | 'error.validation.invalid_amount'
  | 'error.validation.missing_field'
  | 'error.validation.generic'
  // Not found
  | 'error.not_found'
  // Rate limit
  | 'error.rate_limit'
  | 'error.rate_limit.retry_after'
  // Server
  | 'error.server'
  // Network / transport
  | 'error.network'
  | 'error.timeout'
  // Offline / queue
  | 'error.offline.queued'
  | 'error.offline.not_queued'
  | 'error.queue_full'
  // Domain-specific
  | 'error.invalid_stellar_address'
  | 'error.invalid_c_address'
  | 'error.invalid_g_address'
  | 'error.fee_too_high'
  | 'error.amount_too_small'
  | 'error.amount_too_large'
  | 'error.unsupported_exchange';

/** Compile-time mapping from message key → required interpolation params. */
export interface MessageParams {
  'error.unknown': Record<string, never>;
  'error.request_failed': { status: string | number };
  'error.auth.unauthorized': Record<string, never>;
  'error.auth.forbidden': Record<string, never>;
  'error.validation.invalid_address': { address: string };
  'error.validation.invalid_amount': { amount: string };
  'error.validation.missing_field': { field: string };
  'error.validation.generic': { detail: string };
  'error.not_found': Record<string, never>;
  'error.rate_limit': Record<string, never>;
  'error.rate_limit.retry_after': { seconds: string | number };
  'error.server': Record<string, never>;
  'error.network': Record<string, never>;
  'error.timeout': { operation: string; ms: string | number };
  'error.offline.queued': Record<string, never>;
  'error.offline.not_queued': Record<string, never>;
  'error.queue_full': { max: string | number };
  'error.invalid_stellar_address': { address: string };
  'error.invalid_c_address': { address: string };
  'error.invalid_g_address': { address: string };
  'error.fee_too_high': { feeBps: string | number; maxBps: string | number };
  'error.amount_too_small': { amount: string; min: string };
  'error.amount_too_large': { amount: string; max: string };
  'error.unsupported_exchange': { exchange: string };
}

/** A complete set of translations for every {@link MessageKey}. */
export type MessageCatalog = Record<MessageKey, string>;
