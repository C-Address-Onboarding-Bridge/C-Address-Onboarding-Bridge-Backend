import type { MessageCatalog } from './types';

/** Simplified Chinese (zh) translation catalog. */
export const zh: MessageCatalog = {
  'error.unknown':                     '发生未知错误。',
  'error.request_failed':              '请求失败，状态码：{{status}}。',

  'error.auth.unauthorized':           '未授权。请检查您的 API 密钥。',
  'error.auth.forbidden':              '禁止访问。您没有执行此操作的权限。',

  'error.validation.invalid_address':  '无效地址：{{address}}。',
  'error.validation.invalid_amount':   '无效金额：{{amount}}。必须为正整数字符串（stroops）。',
  'error.validation.missing_field':    '缺少必填字段：{{field}}。',
  'error.validation.generic':          '验证错误：{{detail}}。',

  'error.not_found':                   '未找到所请求的资源。',

  'error.rate_limit':                  '请求过于频繁，请放慢速度。',
  'error.rate_limit.retry_after':      '请求过于频繁。请在 {{seconds}} 秒后重试。',

  'error.server':                      '服务器发生错误，请稍后重试。',

  'error.network':                     '发生网络错误。请检查您的连接并重试。',
  'error.timeout':                     '操作"{{operation}}"在 {{ms}} 毫秒后超时。',

  'error.offline.queued':              '您已离线。请求已加入队列，待恢复连接后将自动重试。',
  'error.offline.not_queued':          '您已离线。请求无法加入队列。',
  'error.queue_full':                  '离线队列已满（最多 {{max}} 条）。请求已被丢弃。',

  'error.invalid_stellar_address':     '"{{address}}"不是有效的 Stellar 地址。',
  'error.invalid_c_address':           '"{{address}}"不是有效的 C 地址（Soroban 智能账户）。',
  'error.invalid_g_address':           '"{{address}}"不是有效的 G 地址（经典 Stellar 账户）。',

  'error.fee_too_high':                '手续费 {{feeBps}} bps 超过最大值 {{maxBps}} bps。',
  'error.amount_too_small':            '金额 {{amount}} 低于最小值 {{min}} stroops。',
  'error.amount_too_large':            '金额 {{amount}} 超过最大值 {{max}} stroops。',

  'error.unsupported_exchange':        '不支持交易所"{{exchange}}"。',
};
