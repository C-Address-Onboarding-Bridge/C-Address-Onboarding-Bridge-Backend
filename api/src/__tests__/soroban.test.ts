import { getTransactionStatus } from '../services/soroban';

// Minimal fake RPC server used to drive getTransactionStatus without network.
function makeServer(handler: (method: string, params: any) => any) {
  return {
    getTransaction: async (hash: string) => handler('getTransaction', { hash }),
  } as any;
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
});
