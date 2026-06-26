// Seed data for development/testing environments.
// Run with: npx tsx src/migrations/seed.ts

const NODE_ENV = process.env.NODE_ENV || 'development';

if (NODE_ENV === 'production') {
  console.error('[seed] refusing to run seed in production environment');
  process.exit(1);
}

export const DEV_SEED = {
  apiKeys: ['dev-api-key-001', 'dev-api-key-002'],
  transactions: [
    {
      id: 'seed-tx-001',
      txHash: 'a'.repeat(64),
      status: 'success',
      sourceAddr: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW',
      targetAddr: 'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW',
      tokenAddr: 'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW',
      amount: '1000000',
      feeBps: 30,
      explorerUrl: 'https://stellar.expert/explorer/testnet/tx/' + 'a'.repeat(64),
      createdAt: Date.now() - 3600_000,
      updatedAt: Date.now() - 3000_000,
    },
    {
      id: 'seed-tx-002',
      txHash: 'b'.repeat(64),
      status: 'pending',
      sourceAddr: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW',
      targetAddr: 'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW',
      tokenAddr: 'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW',
      amount: '500000',
      feeBps: 30,
      explorerUrl: null,
      createdAt: Date.now() - 600_000,
      updatedAt: Date.now() - 600_000,
    },
  ],
  webhookRegistrations: [
    {
      id: 'seed-webhook-001',
      apiKey: 'dev-api-key-001',
      url: 'https://webhook.site/dev-test-endpoint',
      events: ['transaction.success', 'transaction.failed'],
    },
  ],
};

async function runSeed() {
  console.log('[seed] inserting development seed data...');
  // When a real DB client is wired in, execute INSERT statements here using DEV_SEED.
  console.log('[seed] seed data (no DB client attached; data logged for reference)');
  console.log(JSON.stringify(DEV_SEED, null, 2));
  console.log('[seed] done');
}

// Only run when executed directly
runSeed().catch(console.error);
