import type { MessageCatalog } from './types';

/** Japanese (ja) translation catalog. */
export const ja: MessageCatalog = {
  'error.unknown':                     '不明なエラーが発生しました。',
  'error.request_failed':              'リクエストがステータス {{status}} で失敗しました。',

  'error.auth.unauthorized':           '認証されていません。APIキーを確認してください。',
  'error.auth.forbidden':              'アクセスが禁止されています。この操作を実行する権限がありません。',

  'error.validation.invalid_address':  '無効なアドレスです: {{address}}。',
  'error.validation.invalid_amount':   '無効な金額です: {{amount}}。正の整数の文字列（stroops）である必要があります。',
  'error.validation.missing_field':    '必須フィールドがありません: {{field}}。',
  'error.validation.generic':          '検証エラー: {{detail}}。',

  'error.not_found':                   '要求されたリソースが見つかりませんでした。',

  'error.rate_limit':                  'リクエストが多すぎます。速度を落としてください。',
  'error.rate_limit.retry_after':      'リクエストが多すぎます。{{seconds}} 秒後に再試行してください。',

  'error.server':                      'サーバーエラーが発生しました。後でもう一度お試しください。',

  'error.network':                     'ネットワークエラーが発生しました。接続を確認して再試行してください。',
  'error.timeout':                     '操作「{{operation}}」は {{ms}} ミリ秒後にタイムアウトしました。',

  'error.offline.queued':              'オフラインです。リクエストはキューに追加され、接続が復旧次第再試行されます。',
  'error.offline.not_queued':          'オフラインです。リクエストをキューに追加できませんでした。',
  'error.queue_full':                  'オフラインキューが満杯です（最大 {{max}} 件）。リクエストは破棄されました。',

  'error.invalid_stellar_address':     '「{{address}}」は有効な Stellar アドレスではありません。',
  'error.invalid_c_address':           '「{{address}}」は有効な C アドレス（Soroban スマートアカウント）ではありません。',
  'error.invalid_g_address':           '「{{address}}」は有効な G アドレス（従来の Stellar アカウント）ではありません。',

  'error.fee_too_high':                '手数料 {{feeBps}} bps が最大値 {{maxBps}} bps を超えています。',
  'error.amount_too_small':            '金額 {{amount}} が最小値 {{min}} stroops を下回っています。',
  'error.amount_too_large':            '金額 {{amount}} が最大値 {{max}} stroops を超えています。',

  'error.unsupported_exchange':        '取引所「{{exchange}}」はサポートされていません。',
};
