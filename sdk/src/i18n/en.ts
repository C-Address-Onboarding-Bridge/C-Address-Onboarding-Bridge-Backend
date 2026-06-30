import type { MessageCatalog } from './types';

/** English (en) — baseline / fallback catalog. */
export const en: MessageCatalog = {
  'error.unknown':                     'An unknown error occurred.',
  'error.request_failed':              'Request failed with status {{status}}.',

  'error.auth.unauthorized':           'Unauthorized. Check your API key.',
  'error.auth.forbidden':              'Forbidden. You do not have permission to perform this action.',

  'error.validation.invalid_address':  'Invalid address: {{address}}.',
  'error.validation.invalid_amount':   'Invalid amount: {{amount}}. Must be a positive integer string (stroops).',
  'error.validation.missing_field':    'Missing required field: {{field}}.',
  'error.validation.generic':          'Validation error: {{detail}}.',

  'error.not_found':                   'The requested resource was not found.',

  'error.rate_limit':                  'Too many requests. Please slow down.',
  'error.rate_limit.retry_after':      'Too many requests. Retry after {{seconds}} seconds.',

  'error.server':                      'A server error occurred. Please try again later.',

  'error.network':                     'A network error occurred. Check your connection and try again.',
  'error.timeout':                     'Operation "{{operation}}" timed out after {{ms}} ms.',

  'error.offline.queued':              'You are offline. The request has been queued and will be retried when connectivity is restored.',
  'error.offline.not_queued':          'You are offline. The request could not be queued.',
  'error.queue_full':                  'Offline queue is full (max {{max}} entries). The request was dropped.',

  'error.invalid_stellar_address':     '"{{address}}" is not a valid Stellar address.',
  'error.invalid_c_address':           '"{{address}}" is not a valid C-address (Soroban smart account).',
  'error.invalid_g_address':           '"{{address}}" is not a valid G-address (classic Stellar account).',

  'error.fee_too_high':                'Fee of {{feeBps}} bps exceeds the maximum of {{maxBps}} bps.',
  'error.amount_too_small':            'Amount {{amount}} is below the minimum of {{min}} stroops.',
  'error.amount_too_large':            'Amount {{amount}} exceeds the maximum of {{max}} stroops.',

  'error.unsupported_exchange':        'Exchange "{{exchange}}" is not supported.',
};
