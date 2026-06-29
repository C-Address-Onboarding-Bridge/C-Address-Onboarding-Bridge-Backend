import { BridgeClient, type QuoteParams, type FundingPrepareResult, utils } from '../../../src';

const quoteParams: QuoteParams = {
  sourceAsset: 'XLM',
  amount: '1000',
  targetAddress: 'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW',
};

const client = new BridgeClient({ baseUrl: 'https://example.com' });

void client.getQuote(quoteParams);
void client.prepareFundingTransaction({
  sourceAddress: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW',
  targetAddress: 'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW',
  tokenAddress: 'CCABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW',
  amount: '1000',
  memo: 'strict',
});

const result: FundingPrepareResult = {
  instruction: 'pay',
  simulation: { status: 'ok' },
  params: {
    sourceAddress: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW',
    targetAddress: 'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW',
    tokenAddress: 'CCABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW',
    amount: '1000',
    memo: 'strict',
  },
};

void result;
void utils.isValidStellarAddress('GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW');
