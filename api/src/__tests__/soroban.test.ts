import { getTransactionStatus, rememberTimeBounds, isTimeBoundsTracked } from '../services/soroban';
import { TransactionBuilder, Networks, Keypair, Account, Operation } from '@stellar/stellar-sdk';

// Minimal fake RPC server used to drive getTransactionStatus without network.
function makeServer(handler: (method: string, params: any) => any) {
  return {
    getTransaction: async (hash: string) => handler('getTransaction', { hash }),
  } as any;
}

function makeTx(maxTime: number) {
  const kp = Keypair.random();
  return new TransactionBuilder(new Account(kp.publicKey(), '0'), {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
    timebounds: { minTime: 0, maxTime },
  })
    .addOperation(Operation.bumpSequence({ bumpTo: '1' }))
    .setTimeout(0)
    .build();
}

describe('getTransactionStatus', () => {
  it('returns success for a successful transaction', async () => {
    const server = makeServer(() => ({
      status: 'SUCCESS',
      ledger: 42,
      envelopeXdr: 'env',
      resultXdr: 'res',
      resultMetaXdr: 'meta',
    }));

    const result = await getTransactionStatus(server, 'abc');

    expect(result.status).toBe('success');
    expect(result.ledger).toBe(42);
  });

  it('returns failed for a failed transaction', async () => {
    const server = makeServer(() => ({
      status: 'FAILED',
      ledger: 43,
      envelopeXdr: 'env',
      resultXdr: 'res',
      resultMetaXdr: 'meta',
    }));

    const result = await getTransactionStatus(server, 'abc');

    expect(result.status).toBe('failed');
    expect(result.ledger).toBe(43);
  });

  it('returns pending for a NOT_FOUND transaction still within its time bounds', async () => {
    const server = makeServer(() => {
      const err: any = new Error('not found');
      err.code = 'NOT_FOUND';
      throw err;
    });

    const result = await getTransactionStatus(server, 'abc', {
      minTime: Math.floor(Date.now() / 1000) - 60,
      maxTime: Math.floor(Date.now() / 1000) + 3600,
    });

    expect(result.status).toBe('pending');
  });

  it('returns expired for a NOT_FOUND transaction past its maxTime', async () => {
    const server = makeServer(() => {
      const err: any = new Error('not found');
      err.code = 'NOT_FOUND';
      throw err;
    });

    const result = await getTransactionStatus(server, 'abc', {
      minTime: Math.floor(Date.now() / 1000) - 7200,
      maxTime: Math.floor(Date.now() / 1000) - 3600,
    });

    expect(result.status).toBe('expired');
  });

  it('returns expired for a NOT_FOUND transaction past the RPC retention window', async () => {
    const server = makeServer(() => {
      const err: any = new Error('not found');
      err.code = 'NOT_FOUND';
      throw err;
    });

    const result = await getTransactionStatus(server, 'abc', {
      minTime: Math.floor(Date.now() / 1000) - 60,
      maxTime: Math.floor(Date.now() / 1000) + 3600,
      submittedAt: Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 30,
    });

    expect(result.status).toBe('expired');
  });

  it('surfaces RPC errors instead of reporting pending', async () => {
    const server = makeServer(() => {
      throw new Error('rpc unavailable');
    });

    await expect(getTransactionStatus(server, 'abc')).rejects.toThrow();
  });

  it('stops tracking a hash after a terminal success status', async () => {
    const hash = 'terminal-success-hash';
    rememberTimeBounds(hash, makeTx(Math.floor(Date.now() / 1000) + 3600));
    expect(isTimeBoundsTracked(hash)).toBe(true);

    const server = makeServer(() => ({
      status: 'SUCCESS',
      ledger: 44,
      envelopeXdr: 'env',
      resultXdr: 'res',
      resultMetaXdr: 'meta',
    }));

    const result = await getTransactionStatus(server, hash);

    expect(result.status).toBe('success');
    expect(isTimeBoundsTracked(hash)).toBe(false);
  });

  it('stops tracking a hash after a terminal failed status', async () => {
    const hash = 'terminal-failed-hash';
    rememberTimeBounds(hash, makeTx(Math.floor(Date.now() / 1000) + 3600));
    expect(isTimeBoundsTracked(hash)).toBe(true);

    const server = makeServer(() => ({
      status: 'FAILED',
      ledger: 45,
      envelopeXdr: 'env',
      resultXdr: 'res',
      resultMetaXdr: 'meta',
    }));

    const result = await getTransactionStatus(server, hash);

    expect(result.status).toBe('failed');
    expect(isTimeBoundsTracked(hash)).toBe(false);
  });

  it('stops tracking a hash after an expired status', async () => {
    const hash = 'terminal-expired-hash';
    rememberTimeBounds(hash, makeTx(Math.floor(Date.now() / 1000) - 3600));
    expect(isTimeBoundsTracked(hash)).toBe(true);

    const server = makeServer(() => {
      const err: any = new Error('not found');
      err.code = 'NOT_FOUND';
      throw err;
    });

    const result = await getTransactionStatus(server, hash);

    expect(result.status).toBe('expired');
    expect(isTimeBoundsTracked(hash)).toBe(false);
  });
});
