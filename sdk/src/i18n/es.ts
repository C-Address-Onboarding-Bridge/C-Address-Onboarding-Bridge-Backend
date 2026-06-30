import type { MessageCatalog } from './types';

/** Spanish (es) translation catalog. */
export const es: MessageCatalog = {
  'error.unknown':                     'Ocurrió un error desconocido.',
  'error.request_failed':              'La solicitud falló con el estado {{status}}.',

  'error.auth.unauthorized':           'No autorizado. Comprueba tu clave de API.',
  'error.auth.forbidden':              'Prohibido. No tienes permiso para realizar esta acción.',

  'error.validation.invalid_address':  'Dirección inválida: {{address}}.',
  'error.validation.invalid_amount':   'Monto inválido: {{amount}}. Debe ser una cadena de entero positivo (stroops).',
  'error.validation.missing_field':    'Campo requerido faltante: {{field}}.',
  'error.validation.generic':          'Error de validación: {{detail}}.',

  'error.not_found':                   'El recurso solicitado no fue encontrado.',

  'error.rate_limit':                  'Demasiadas solicitudes. Por favor, reduce la velocidad.',
  'error.rate_limit.retry_after':      'Demasiadas solicitudes. Reintenta después de {{seconds}} segundos.',

  'error.server':                      'Ocurrió un error en el servidor. Inténtalo de nuevo más tarde.',

  'error.network':                     'Ocurrió un error de red. Verifica tu conexión y vuelve a intentarlo.',
  'error.timeout':                     'La operación "{{operation}}" expiró después de {{ms}} ms.',

  'error.offline.queued':              'Estás sin conexión. La solicitud ha sido encolada y se reintentará cuando se restaure la conectividad.',
  'error.offline.not_queued':          'Estás sin conexión. La solicitud no pudo ser encolada.',
  'error.queue_full':                  'La cola sin conexión está llena (máximo {{max}} entradas). La solicitud fue descartada.',

  'error.invalid_stellar_address':     '"{{address}}" no es una dirección Stellar válida.',
  'error.invalid_c_address':           '"{{address}}" no es una C-address válida (cuenta inteligente Soroban).',
  'error.invalid_g_address':           '"{{address}}" no es una G-address válida (cuenta Stellar clásica).',

  'error.fee_too_high':                'La comisión de {{feeBps}} bps supera el máximo de {{maxBps}} bps.',
  'error.amount_too_small':            'El monto {{amount}} está por debajo del mínimo de {{min}} stroops.',
  'error.amount_too_large':            'El monto {{amount}} supera el máximo de {{max}} stroops.',

  'error.unsupported_exchange':        'El exchange "{{exchange}}" no es compatible.',
};
