export type ExplorerName = 'stellarexpert' | 'stellarchain' | 'sorobanexplorer';

interface ExplorerConfig {
  tx: (_hash: string, _network: string) => string;
  account: (_address: string, _network: string) => string;
  contract: (_id: string, _network: string) => string;
}

const NETWORK_MAP: Record<string, string> = {
  'Test SDF Network ; September 2015': 'testnet',
  'Public Global Stellar Network ; September 2015': 'public',
};

function networkSlug(passphrase: string): string {
  return NETWORK_MAP[passphrase] ?? 'testnet';
}

const EXPLORERS: Record<ExplorerName, ExplorerConfig> = {
  stellarexpert: {
    tx: (hash, network) => `https://stellar.expert/explorer/${network}/tx/${hash}`,
    account: (addr, network) => `https://stellar.expert/explorer/${network}/account/${addr}`,
    contract: (id, network) => `https://stellar.expert/explorer/${network}/contract/${id}`,
  },
  stellarchain: {
    tx: (hash, _network) => `https://stellarchain.io/transactions/${hash}`,
    account: (addr, _network) => `https://stellarchain.io/accounts/${addr}`,
    contract: (id, _network) => `https://stellarchain.io/accounts/${id}`,
  },
  sorobanexplorer: {
    tx: (hash, network) => `https://sorobanexplorer.com/${network}/tx/${hash}`,
    account: (addr, network) => `https://sorobanexplorer.com/${network}/account/${addr}`,
    contract: (id, network) => `https://sorobanexplorer.com/${network}/contract/${id}`,
  },
};

const FALLBACK_ORDER: ExplorerName[] = ['stellarexpert', 'stellarchain', 'sorobanexplorer'];

export class ExplorerService {
  private primary: ExplorerName;
  private networkPassphrase: string;

  constructor(opts?: { explorer?: string; networkPassphrase?: string }) {
    const env = ((opts?.explorer ?? process.env.STELLAR_EXPLORER) || 'stellarexpert').toLowerCase() as ExplorerName;
    this.primary = EXPLORERS[env] ? env : 'stellarexpert';
    this.networkPassphrase =
      opts?.networkPassphrase ??
      process.env.SOROBAN_NETWORK_PASSPHRASE ??
      'Test SDF Network ; September 2015';
  }

  private get network(): string {
    return networkSlug(this.networkPassphrase);
  }

  private explorerFor(name: ExplorerName): ExplorerConfig {
    return EXPLORERS[name] ?? EXPLORERS['stellarexpert'];
  }

  txUrl(hash: string): string {
    return this.explorerFor(this.primary).tx(hash, this.network);
  }

  accountUrl(address: string): string {
    return this.explorerFor(this.primary).account(address, this.network);
  }

  contractUrl(contractId: string): string {
    return this.explorerFor(this.primary).contract(contractId, this.network);
  }

  txUrlWithFallbacks(hash: string): Record<ExplorerName, string> {
    const result = {} as Record<ExplorerName, string>;
    for (const name of FALLBACK_ORDER) {
      result[name] = EXPLORERS[name].tx(hash, this.network);
    }
    return result;
  }
}

export const explorerService = new ExplorerService();
