/** Thrown at startup when a required environment variable is missing. */
export class ConfigError extends Error {
  constructor(key: string) {
    super(`missing required config: ${key}`);
    this.name = 'ConfigError';
  }
}

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new ConfigError(key);
  return val;
}

/** Centralised runtime configuration derived from environment variables. */
export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  host: process.env.HOST || '0.0.0.0',
  soroban: {
    rpcUrl: process.env.SOROBAN_RPC_URL || 'https://soroban-rpc.testnet.stellar.org',
    networkPassphrase: process.env.SOROBAN_NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015',
    bridgeContractId: process.env.BRIDGE_CONTRACT_ID || '',
    feeBps: parseInt(process.env.BRIDGE_FEE_BPS || '30', 10),
  },
  moonpay: {
    apiKey: process.env.MOONPAY_API_KEY || '',
    secretKey: process.env.MOONPAY_SECRET_KEY || '',
  },
  transak: {
    apiKey: process.env.TRANSAK_API_KEY || '',
    environment: process.env.TRANSAK_ENVIRONMENT || 'STAGING',
  },
  /** Comma-separated list of accepted `X-API-Key` values. Auth is disabled when empty. */
  apiKeys: (process.env.API_KEYS || '').split(',').filter(Boolean),
  logLevel: process.env.LOG_LEVEL || 'info',
};
