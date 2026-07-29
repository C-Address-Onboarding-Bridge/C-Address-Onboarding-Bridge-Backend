import type { MessageCatalog } from './types';

/** Korean (ko) translation catalog. */
export const ko: MessageCatalog = {
  'error.unknown':                     '알 수 없는 오류가 발생했습니다.',
  'error.request_failed':              '요청이 상태 코드 {{status}}(으)로 실패했습니다.',

  'error.auth.unauthorized':           '인증되지 않았습니다. API 키를 확인하세요.',
  'error.auth.forbidden':              '금지되었습니다. 이 작업을 수행할 권한이 없습니다.',

  'error.validation.invalid_address':  '잘못된 주소입니다: {{address}}.',
  'error.validation.invalid_amount':   '잘못된 금액입니다: {{amount}}. 양의 정수 문자열(stroops)이어야 합니다.',
  'error.validation.missing_field':    '필수 필드가 없습니다: {{field}}.',
  'error.validation.generic':          '유효성 검사 오류: {{detail}}.',

  'error.not_found':                   '요청한 리소스를 찾을 수 없습니다.',

  'error.rate_limit':                  '요청이 너무 많습니다. 속도를 줄여주세요.',
  'error.rate_limit.retry_after':      '요청이 너무 많습니다. {{seconds}}초 후에 다시 시도하세요.',

  'error.server':                      '서버 오류가 발생했습니다. 나중에 다시 시도하세요.',

  'error.network':                     '네트워크 오류가 발생했습니다. 연결을 확인하고 다시 시도하세요.',
  'error.timeout':                     '작업 "{{operation}}"이(가) {{ms}}ms 후에 시간 초과되었습니다.',

  'error.offline.queued':              '오프라인 상태입니다. 요청이 대기열에 추가되었으며 연결이 복구되면 재시도됩니다.',
  'error.offline.not_queued':          '오프라인 상태입니다. 요청을 대기열에 추가할 수 없습니다.',
  'error.queue_full':                  '오프라인 대기열이 가득 찼습니다(최대 {{max}}개). 요청이 삭제되었습니다.',

  'error.invalid_stellar_address':     '"{{address}}"은(는) 유효한 Stellar 주소가 아닙니다.',
  'error.invalid_c_address':           '"{{address}}"은(는) 유효한 C-address(Soroban 스마트 계정)가 아닙니다.',
  'error.invalid_g_address':           '"{{address}}"은(는) 유효한 G-address(기존 Stellar 계정)가 아닙니다.',

  'error.fee_too_high':                '수수료 {{feeBps}} bps가 최대값 {{maxBps}} bps를 초과합니다.',
  'error.amount_too_small':            '금액 {{amount}}이(가) 최소값 {{min}} stroops보다 작습니다.',
  'error.amount_too_large':            '금액 {{amount}}이(가) 최대값 {{max}} stroops를 초과합니다.',

  'error.unsupported_exchange':        '거래소 "{{exchange}}"은(는) 지원되지 않습니다.',
};
