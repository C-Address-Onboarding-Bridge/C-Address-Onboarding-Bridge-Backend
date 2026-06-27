import type {
  Quote,
  FundingResult,
  TransactionStatus,
  FundingPrepareResult,
  CexWithdrawalResult,
  MoonpayWidgetResult,
  TransakWidgetResult,
  BridgeStatus,
  QuoteParams,
  FundParams,
} from '../types';

/** Valid 56-char Stellar C-address (Soroban contract) for use in tests. */
export const MOCK_C_ADDRESS = 'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTU';
/** Valid 56-char Stellar G-address (classic account) for use in tests. */
export const MOCK_G_ADDRESS = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTU';
/** Valid 56-char token contract address for use in tests. */
export const MOCK_TOKEN_ADDRESS = 'CATOKEN7ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMN';
/** Deterministic mock transaction hash for use in test assertions. */
export const MOCK_TX_HASH = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

/** Ready-to-use QuoteParams fixture. */
export const MOCK_QUOTE_PARAMS: QuoteParams = {
  sourceAsset: 'XLM',
  amount: '10000',
  targetAddress: MOCK_C_ADDRESS,
};

/** Ready-to-use FundParams fixture. */
export const MOCK_FUND_PARAMS: FundParams = {
  sourceAddress: MOCK_G_ADDRESS,
  targetAddress: MOCK_C_ADDRESS,
  tokenAddress: MOCK_TOKEN_ADDRESS,
  amount: '10000',
  memo: 'test',
};

/**
 * Type-safe fixture factories that return realistic mock response objects.
 * Every factory accepts an optional overrides argument for targeted customisation.
 *
 * @example
 * const quote = fixtures.quote({ rate: '2.0' });
 * const failed = fixtures.transactionStatus('failed');
 */
export const fixtures = {
  quote(overrides?: Partial<Quote>): Quote {
    return {
      estimatedFee: '100',
      expectedReceive: '9900',
      feeBps: 100,
      rate: '1.0',
      ...overrides,
    };
  },

  fundingResult(overrides?: Partial<FundingResult>): FundingResult {
    return {
      status: 'pending',
      hash: MOCK_TX_HASH,
      ...overrides,
    };
  },

  transactionStatus(status: BridgeStatus = 'pending', overrides?: Partial<TransactionStatus>): TransactionStatus {
    return {
      status,
      hash: MOCK_TX_HASH,
      ...(status === 'failed' && { error: 'Transaction reverted' }),
      ...overrides,
    };
  },

  fundingPrepareResult(overrides?: Partial<FundingPrepareResult>): FundingPrepareResult {
    return {
      instruction: 'sign-and-submit',
      simulation: { status: 'success', fee: '100' },
      params: { ...MOCK_FUND_PARAMS },
      ...overrides,
    };
  },

  cexWithdrawalResult(overrides?: Partial<CexWithdrawalResult>): CexWithdrawalResult {
    return {
      status: 'pending',
      withdrawalId: 'wd-mock-0001',
      exchangeTxId: 'exch-0001',
      estimatedArrival: '2024-01-01T00:05:00.000Z',
      fee: '5',
      ...overrides,
    };
  },

  moonpayWidgetResult(overrides?: Partial<MoonpayWidgetResult>): MoonpayWidgetResult {
    return {
      url: `https://buy.moonpay.com?apiKey=mock&walletAddress=${MOCK_C_ADDRESS}`,
      ...overrides,
    };
  },

  transakWidgetResult(overrides?: Partial<TransakWidgetResult>): TransakWidgetResult {
    return {
      url: `https://global.transak.com?apiKey=mock&walletAddress=${MOCK_C_ADDRESS}`,
      ...overrides,
    };
  },

  /** Standard API error body shape, matching what the real API returns. */
  apiError(message: string, code?: string): { message: string; code?: string } {
    return code !== undefined ? { message, code } : { message };
  },
};
