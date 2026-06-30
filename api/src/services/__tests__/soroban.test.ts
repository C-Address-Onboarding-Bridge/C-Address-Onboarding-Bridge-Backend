import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';
import { rpcPool } from '../rpcPool';

// Mock the rpcPool module so soroban.ts gets the mocked version.
vi.mock('../rpcPool');

describe('SorobanService', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  describe('getQuote', () => {
    it('returns a quote with fee calculation', async () => {
      process.env.SOROBAN_RPC_URL = 'https://soroban-rpc.testnet.stellar.org';
      process.env.BRIDGE_FEE_BPS = '30';
      const { SorobanService } = await import('../soroban');
      const service = new SorobanService();
      const quote = await service.getQuote('XLM', '1000', 'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW');
      expect(quote).toHaveProperty('estimatedFee');
      expect(quote).toHaveProperty('expectedReceive');
      expect(quote).toHaveProperty('feeBps');
      expect(quote.feeBps).toBe(30);
      expect(quote.estimatedFee).toBe('3');
      expect(quote.expectedReceive).toBe('997');
    });

    it('returns zero fee when fee is zero', async () => {
      process.env.SOROBAN_RPC_URL = 'https://soroban-rpc.testnet.stellar.org';
      process.env.BRIDGE_FEE_BPS = '0';
      const { SorobanService } = await import('../soroban');
      const zeroService = new SorobanService();
      const quote = await zeroService.getQuote('XLM', '1000', 'C...');
      expect(quote.estimatedFee).toBe('0');
      expect(quote.expectedReceive).toBe('1000');
    });
  });

  describe('contractSimulate', () => {
    // Use a known-valid Stellar source address generated via Keypair.random()
    const sourceAddress = Keypair.random().publicKey();
    // The null contract ID is a well-known valid contract address
    const contractId = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';

    it('returns not_configured when contract ID is empty', async () => {
      process.env.SOROBAN_RPC_URL = 'https://soroban-rpc.testnet.stellar.org';
      process.env.BRIDGE_CONTRACT_ID = '';
      process.env.SOROBAN_NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';

      const { SorobanService } = await import('../soroban');
      const service = new SorobanService();

      const result = await service.contractSimulate(
        sourceAddress,
        'fund_c_address',
        contractId,
        contractId,
        '1000',
        '',
      );
      expect(result).toEqual({ footprint: 'not_configured', minResourceFee: '0' });
      expect(rpcPool.execute).not.toHaveBeenCalled();
    });

    it('returns simulation results from RPC on success', async () => {
      process.env.SOROBAN_RPC_URL = 'https://soroban-rpc.testnet.stellar.org';
      process.env.BRIDGE_CONTRACT_ID = contractId;
      process.env.SOROBAN_NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';

      const mockTransactionData = {
        build: () => ({
          toXDR: (_format: string) => 'AAAAEgAAAAA=',
        }),
      };

      vi.mocked(rpcPool.execute).mockResolvedValue({
        transactionData: mockTransactionData,
        minResourceFee: '100',
      });

      const { SorobanService } = await import('../soroban');
      const service = new SorobanService();

      const result = await service.contractSimulate(
        sourceAddress,
        'fund_c_address',
        contractId,
        contractId,
        '1000',
        'test-memo',
      );

      expect(rpcPool.execute).toHaveBeenCalledTimes(1);
      expect(result.footprint).toBe('AAAAEgAAAAA=');
      expect(result.minResourceFee).toBe('100');
    });

    it('returns error footprint when RPC returns a simulation error', async () => {
      process.env.SOROBAN_RPC_URL = 'https://soroban-rpc.testnet.stellar.org';
      process.env.BRIDGE_CONTRACT_ID = contractId;
      process.env.SOROBAN_NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';

      vi.mocked(rpcPool.execute).mockResolvedValue({
        error: 'HostError: contract call failed',
      });

      const { SorobanService } = await import('../soroban');
      const service = new SorobanService();

      const result = await service.contractSimulate(
        sourceAddress,
        'fund_c_address',
        contractId,
        contractId,
        '1000',
        '',
      );

      expect(result).toEqual({ footprint: 'error', minResourceFee: '0' });
    });

    it('returns simulation_failed when RPC execution throws', async () => {
      process.env.SOROBAN_RPC_URL = 'https://soroban-rpc.testnet.stellar.org';
      process.env.BRIDGE_CONTRACT_ID = contractId;
      process.env.SOROBAN_NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';

      vi.mocked(rpcPool.execute).mockRejectedValue(new Error('RPC connection refused'));

      const { SorobanService } = await import('../soroban');
      const service = new SorobanService();

      const result = await service.contractSimulate(
        sourceAddress,
        'fund_c_address',
        contractId,
        contractId,
        '1000',
        '',
      );

      expect(result).toEqual({ footprint: 'simulation_failed', minResourceFee: '0' });
    });
  });
});
