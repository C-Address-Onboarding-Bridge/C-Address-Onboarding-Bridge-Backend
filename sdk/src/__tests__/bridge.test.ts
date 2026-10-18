import axios from 'axios';
import { BridgeClient } from '../bridge';

jest.mock('axios');

const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('BridgeClient.getStatus caching', () => {
  let getMock: jest.Mock;
  let client: BridgeClient;

  beforeEach(() => {
    getMock = jest.fn();
    mockedAxios.create = jest.fn().mockReturnValue({ get: getMock }) as unknown as typeof axios.create;
    client = new BridgeClient({ baseUrl: 'https://example.test', statusCacheTtlMs: 60_000 });
  });

  it('does not serve a stale pending status after the transaction succeeds', async () => {
    getMock
      .mockResolvedValueOnce({ data: { status: 'pending' } })
      .mockResolvedValueOnce({ data: { status: 'success', txHash: '0xabc' } });

    const first = await client.getStatus('0xabc');
    expect(first.status).toBe('pending');

    const second = await client.getStatus('0xabc');
    expect(second.status).toBe('success');
    expect(getMock).toHaveBeenCalledTimes(2);
  });

  it('caches terminal statuses', async () => {
    getMock.mockResolvedValueOnce({ data: { status: 'success', txHash: '0xdef' } });

    const first = await client.getStatus('0xdef');
    const second = await client.getStatus('0xdef');

    expect(first.status).toBe('success');
    expect(second.status).toBe('success');
    expect(getMock).toHaveBeenCalledTimes(1);
  });

  it('deduplicates concurrent pending refreshes', async () => {
    getMock.mockResolvedValue({ data: { status: 'pending' } });

    const [a, b] = await Promise.all([
      client.getStatus('0x123'),
      client.getStatus('0x123'),
    ]);

    expect(a.status).toBe('pending');
    expect(b.status).toBe('pending');
    expect(getMock).toHaveBeenCalledTimes(1);
  });
});
