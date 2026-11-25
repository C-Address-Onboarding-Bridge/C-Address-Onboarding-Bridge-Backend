import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Account, Keypair, SorobanDataBuilder, Transaction } from '@stellar/stellar-sdk';
import { errorHandler } from '../../middleware/error';

const executeMock = vi.fn();
vi.mock('../rpcPool', () => ({ rpcPool: { execute: executeMock } }));

describe('SorobanService.prepareFundingTransaction', () => {
  const source = Keypair.random().publicKey();
  const target = source;
  const transactionData = new SorobanDataBuilder()
    .setResourceFee('1000')
    .setResources(100, 100, 100);

  beforeEach(() => {
    vi.resetModules();
    executeMock.mockReset();
    process.env.SOROBAN_RPC_URL = 'https://soroban-rpc.testnet.stellar.org';
    process.env.BRIDGE_CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
    process.env.SOROBAN_NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
  });

  afterEach(() => vi.restoreAllMocks());

  async function serviceAndAccount() {
    const { SorobanService } = await import('../soroban');
    const account = new Account(source, '1');
    executeMock.mockImplementation(async (fn) => fn({
      getAccount: async () => account,
      simulateTransaction: async () => ({}),
    }));
    return new SorobanService();
  }

  it('throws a simulation error when SDK assembly fails', async () => {
    const service = await serviceAndAccount();
    const simulation = { transactionData, minResourceFee: '100', result: { auth: [] } };
    executeMock.mockImplementation(async (fn) => fn({
      getAccount: async () => new Account(source, '1'),
      simulateTransaction: async () => simulation,
    }));
    const { SorobanService } = await import('../soroban');
    vi.spyOn(SorobanService, 'assembleTransaction').mockImplementation(() => {
      throw new Error('assembly broke');
    });

    await expect(service.prepareFundingTransaction({ source, target, amount: '1000' }))
      .rejects.toMatchObject({ code: 'SIMULATION_FAILED' });
  });

  it('rejects restore-required simulations with the restore preamble', async () => {
    const service = await serviceAndAccount();
    const restorePreamble = { transactionData: {} };
    executeMock.mockImplementation(async (fn) => fn({
      getAccount: async () => new Account(source, '1'),
      simulateTransaction: async () => ({ transactionData, restorePreamble }),
    }));

    await expect(service.prepareFundingTransaction({ source, target, amount: '1000' }))
      .rejects.toMatchObject({ code: 'RESTORE_REQUIRED', restorePreamble });
  });

  it('maps simulation failures to a non-success HTTP response', async () => {
    const response = {
      statusCode: 200,
      body: undefined as unknown,
      status(code: number) { this.statusCode = code; return this; },
      json(body: unknown) { this.body = body; return this; },
    };
    errorHandler(
      Object.assign(new Error('Funding transaction assembly failed'), { code: 'SIMULATION_FAILED' }),
      {} as never,
      response as never,
      vi.fn(),
    );

    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({ error: 'SIMULATION_FAILED' });
  });

  it('returns the assembled envelope fee and simulation transaction data footprint', async () => {
    const service = await serviceAndAccount();
    executeMock.mockImplementation(async (fn) => fn({
      getAccount: async () => new Account(source, '1'),
      simulateTransaction: async () => ({
        _parsed: true,
        transactionData,
        minResourceFee: '100',
        result: { auth: [] },
      }),
    }));
    const { SorobanService } = await import('../soroban');

    const prepared = await service.prepareFundingTransaction({ source, target, amount: '1000' });
    const envelope = new Transaction(prepared.unsignedXdr, 'Test SDF Network ; September 2015');
    const sorobanData = envelope.toEnvelope().v1().tx().ext().sorobanData();

    expect(Number(prepared.fee)).toBeGreaterThan(100);
    expect(sorobanData).toBeDefined();
    expect(sorobanData.resourceFee().toString()).toBe('1000');
    expect(prepared.footprint).toBe(transactionData.build().toXDR('base64'));
  });
});
