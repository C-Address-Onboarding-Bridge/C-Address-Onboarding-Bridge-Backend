/**
 * Sanitized Moonpay webhook payload fixtures.
 * Structure matches real Moonpay webhook events (IPN callbacks).
 * Sensitive fields replaced with plausible test values.
 * Ref: https://dev.moonpay.com/reference/webhooks
 */

export interface MoonpayWebhookPayload {
  type: string;
  data: {
    id: string;
    status: string;
    cryptoTransactionId: string | null;
    walletAddress: string;
    currencyCode: string;
    baseCurrencyAmount: number;
    baseCurrencyCode: string;
    feeAmount: number;
    networkFeeAmount: number;
    quoteCurrencyAmount: number;
    createdAt: string;
    updatedAt: string;
    externalTransactionId: string | null;
    failureReason: string | null;
  };
}

const BASE_TRANSACTION = {
  walletAddress: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
  currencyCode: 'xlm',
  baseCurrencyCode: 'usd',
  baseCurrencyAmount: 100.0,
  feeAmount: 3.99,
  networkFeeAmount: 0.01,
  quoteCurrencyAmount: 95.12,
  externalTransactionId: null,
};

export const moonpaySuccess: MoonpayWebhookPayload = {
  type: 'transaction_updated',
  data: {
    ...BASE_TRANSACTION,
    id: 'mp-txn-00000000-0000-4000-a000-000000000001',
    status: 'completed',
    cryptoTransactionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    createdAt: '2026-01-01T10:00:00.000Z',
    updatedAt: '2026-01-01T10:05:00.000Z',
    failureReason: null,
  },
};

export const moonpayFailed: MoonpayWebhookPayload = {
  type: 'transaction_updated',
  data: {
    ...BASE_TRANSACTION,
    id: 'mp-txn-00000000-0000-4000-a000-000000000002',
    status: 'failed',
    cryptoTransactionId: null,
    createdAt: '2026-01-01T11:00:00.000Z',
    updatedAt: '2026-01-01T11:02:00.000Z',
    failureReason: 'card_declined',
  },
};

export const moonpayRefund: MoonpayWebhookPayload = {
  type: 'transaction_updated',
  data: {
    ...BASE_TRANSACTION,
    id: 'mp-txn-00000000-0000-4000-a000-000000000003',
    status: 'refunded',
    cryptoTransactionId: null,
    createdAt: '2026-01-01T12:00:00.000Z',
    updatedAt: '2026-01-01T12:10:00.000Z',
    failureReason: null,
  },
};
