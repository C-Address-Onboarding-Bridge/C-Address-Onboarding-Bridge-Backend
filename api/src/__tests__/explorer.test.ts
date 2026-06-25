import { describe, it, expect } from 'vitest';
import { ExplorerService } from '../services/explorer';

const TESTNET = 'Test SDF Network ; September 2015';
const MAINNET = 'Public Global Stellar Network ; September 2015';

const TX_HASH = 'a'.repeat(64);
const ACCOUNT = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW';
const CONTRACT = 'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW';

describe('ExplorerService', () => {
  describe('stellarexpert (default)', () => {
    it('generates testnet tx URL', () => {
      const svc = new ExplorerService({ explorer: 'stellarexpert', networkPassphrase: TESTNET });
      expect(svc.txUrl(TX_HASH)).toBe(`https://stellar.expert/explorer/testnet/tx/${TX_HASH}`);
    });

    it('generates mainnet tx URL when network passphrase is mainnet', () => {
      const svc = new ExplorerService({ explorer: 'stellarexpert', networkPassphrase: MAINNET });
      expect(svc.txUrl(TX_HASH)).toBe(`https://stellar.expert/explorer/public/tx/${TX_HASH}`);
    });

    it('generates account URL containing the address', () => {
      const svc = new ExplorerService({ explorer: 'stellarexpert', networkPassphrase: TESTNET });
      const url = svc.accountUrl(ACCOUNT);
      expect(url).toContain('/account/');
      expect(url).toContain(ACCOUNT);
    });

    it('generates contract URL containing the contract id', () => {
      const svc = new ExplorerService({ explorer: 'stellarexpert', networkPassphrase: TESTNET });
      const url = svc.contractUrl(CONTRACT);
      expect(url).toContain('/contract/');
      expect(url).toContain(CONTRACT);
    });
  });

  describe('stellarchain explorer', () => {
    it('generates tx URL', () => {
      const svc = new ExplorerService({ explorer: 'stellarchain', networkPassphrase: TESTNET });
      expect(svc.txUrl(TX_HASH)).toBe(`https://stellarchain.io/transactions/${TX_HASH}`);
    });

    it('generates account URL', () => {
      const svc = new ExplorerService({ explorer: 'stellarchain', networkPassphrase: TESTNET });
      expect(svc.accountUrl(ACCOUNT)).toContain('stellarchain.io/accounts/');
    });
  });

  describe('sorobanexplorer explorer', () => {
    it('generates tx URL with hash', () => {
      const svc = new ExplorerService({ explorer: 'sorobanexplorer', networkPassphrase: TESTNET });
      const url = svc.txUrl(TX_HASH);
      expect(url).toContain('sorobanexplorer.com');
      expect(url).toContain(TX_HASH);
    });
  });

  describe('fallback to stellarexpert for unknown explorer name', () => {
    it('falls back when given an unrecognized explorer name', () => {
      const svc = new ExplorerService({ explorer: 'unknown-explorer', networkPassphrase: TESTNET });
      expect(svc.txUrl(TX_HASH)).toContain('stellar.expert');
    });
  });

  describe('txUrlWithFallbacks', () => {
    it('returns URLs for all supported explorers', () => {
      const svc = new ExplorerService({ explorer: 'stellarexpert', networkPassphrase: TESTNET });
      const urls = svc.txUrlWithFallbacks(TX_HASH);
      expect(urls).toHaveProperty('stellarexpert');
      expect(urls).toHaveProperty('stellarchain');
      expect(urls).toHaveProperty('sorobanexplorer');
    });

    it('each fallback URL contains the tx hash', () => {
      const svc = new ExplorerService({ explorer: 'stellarexpert', networkPassphrase: TESTNET });
      const urls = svc.txUrlWithFallbacks(TX_HASH);
      for (const url of Object.values(urls)) {
        expect(url).toContain(TX_HASH);
      }
    });
  });
});
