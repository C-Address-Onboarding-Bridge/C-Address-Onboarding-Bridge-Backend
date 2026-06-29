/**
 * Sanitized Transak webhook payload fixtures.
 * Structure matches real Transak webhook events.
 * Sensitive fields replaced with plausible test values.
 * Ref: https://docs.transak.com/docs/webhooks
 */

export interface TransakWebhookPayload {
  webhookData: {
    id: string;
    status: string;
    partnerOrderId: string | null;
    walletAddress: string;
    cryptoCurrency: string;
    fiatCurrency: string;
    fiatAmount: number;
    cryptoAmount: number | null;
    totalFeeInFiat: number;
    transactionHash: string | null;
    network: string;
    isBuyOrSell: 'BUY' | 'SELL';
    createdAt: string;
    updatedAt: string;
    failureReason: string | null;
  };
  webhookTimestamp: number;
}

const NOW_ISO = '2026-01-01T10:00:00.000Z';
const NOW_MS = new Date(NOW_ISO).getTime();

const BASE_ORDER = {
  walletAddress: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
  cryptoCurrency: 'XLM',
  fiatCurrency: 'USD',
  fiatAmount: 100.0,
  totalFeeInFiat: 3.99,
  network: 'stellar',
  isBuyOrSell: 'BUY' as const,
  partnerOrderId: null,
};

export const transakSuccess: TransakWebhookPayload = {
  webhookData: {
    ...BASE_ORDER,
    id: 'tk-ord-00000000-0000-4000-b000-000000000001',
    status: 'COMPLETED',
    cryptoAmount: 95.12,
    transactionHash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    failureReason: null,
  },
  webhookTimestamp: NOW_MS,
};

export const transakFailed: TransakWebhookPayload = {
  webhookData: {
    ...BASE_ORDER,
    id: 'tk-ord-00000000-0000-4000-b000-000000000002',
    status: 'FAILED',
    cryptoAmount: null,
    transactionHash: null,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    failureReason: 'payment_declined',
  },
  webhookTimestamp: NOW_MS,
};

export const transakPending: TransakWebhookPayload = {
  webhookData: {
    ...BASE_ORDER,
    id: 'tk-ord-00000000-0000-4000-b000-000000000003',
    status: 'PENDING_DELIVERY_FROM_TRANSAK',
    cryptoAmount: null,
    transactionHash: null,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    failureReason: null,
  },
  webhookTimestamp: NOW_MS,
};
