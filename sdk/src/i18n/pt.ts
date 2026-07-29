import type { MessageCatalog } from './types';

/** Portuguese (pt) translation catalog. */
export const pt: MessageCatalog = {
  'error.unknown':                     'Ocorreu um erro desconhecido.',
  'error.request_failed':              'A solicitação falhou com o status {{status}}.',

  'error.auth.unauthorized':           'Não autorizado. Verifique sua chave de API.',
  'error.auth.forbidden':              'Proibido. Você não tem permissão para realizar esta ação.',

  'error.validation.invalid_address':  'Endereço inválido: {{address}}.',
  'error.validation.invalid_amount':   'Valor inválido: {{amount}}. Deve ser uma string de inteiro positivo (stroops).',
  'error.validation.missing_field':    'Campo obrigatório ausente: {{field}}.',
  'error.validation.generic':          'Erro de validação: {{detail}}.',

  'error.not_found':                   'O recurso solicitado não foi encontrado.',

  'error.rate_limit':                  'Muitas solicitações. Por favor, diminua a velocidade.',
  'error.rate_limit.retry_after':      'Muitas solicitações. Tente novamente após {{seconds}} segundos.',

  'error.server':                      'Ocorreu um erro no servidor. Tente novamente mais tarde.',

  'error.network':                     'Ocorreu um erro de rede. Verifique sua conexão e tente novamente.',
  'error.timeout':                     'A operação "{{operation}}" expirou após {{ms}} ms.',

  'error.offline.queued':              'Você está offline. A solicitação foi enfileirada e será repetida quando a conectividade for restaurada.',
  'error.offline.not_queued':          'Você está offline. A solicitação não pôde ser enfileirada.',
  'error.queue_full':                  'A fila offline está cheia (máximo de {{max}} entradas). A solicitação foi descartada.',

  'error.invalid_stellar_address':     '"{{address}}" não é um endereço Stellar válido.',
  'error.invalid_c_address':           '"{{address}}" não é uma C-address válida (conta inteligente Soroban).',
  'error.invalid_g_address':           '"{{address}}" não é uma G-address válida (conta Stellar clássica).',

  'error.fee_too_high':                'A taxa de {{feeBps}} bps excede o máximo de {{maxBps}} bps.',
  'error.amount_too_small':            'O valor {{amount}} está abaixo do mínimo de {{min}} stroops.',
  'error.amount_too_large':            'O valor {{amount}} excede o máximo de {{max}} stroops.',

  'error.unsupported_exchange':        'A exchange "{{exchange}}" não é suportada.',
};
