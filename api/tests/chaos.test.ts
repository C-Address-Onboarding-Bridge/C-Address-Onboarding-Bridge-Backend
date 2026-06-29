import { test, expect, beforeAll, afterAll } from 'vitest';
import { Toxiproxy } from 'toxiproxy-node-client';

const toxiproxy = new Toxiproxy('http://localhost:8474');

describe('Chaos Testing External Services', () => {
  let sorobanProxy;
  let moonpayProxy;

  beforeAll(async () => {
    sorobanProxy = await toxiproxy.createProxy({
      name: 'soroban',
      listen: '0.0.0.0:8001',
      upstream: 'soroban-rpc:8000',
    });
    
    moonpayProxy = await toxiproxy.createProxy({
      name: 'moonpay',
      listen: '0.0.0.0:8002',
      upstream: 'api.moonpay.com:443',
    });
  });

  afterAll(async () => {
    if (sorobanProxy) await sorobanProxy.remove();
    if (moonpayProxy) await moonpayProxy.remove();
  });

  test('System handles Soroban RPC timeout (5s delay)', async () => {
    const toxic = await sorobanProxy.addToxic(
      new toxiproxy.Toxic(sorobanProxy, {
        type: 'latency',
        attributes: { latency: 5000, jitter: 100 },
      })
    );

    // Call API that depends on Soroban
    const res = await fetch('http://localhost:3000/api/v1/soroban-data');
    expect(res.status).toBeGreaterThanOrEqual(400); // Should fail gracefully or timeout handled
    
    await toxic.remove();
  }, 10000);

  test('System handles Soroban RPC errors (network partition)', async () => {
    const toxic = await sorobanProxy.addToxic(
      new toxiproxy.Toxic(sorobanProxy, {
        type: 'timeout',
        attributes: { timeout: 1000 },
      })
    );

    // Call API
    const res = await fetch('http://localhost:3000/api/v1/soroban-data');
    expect(res.status).toBeGreaterThanOrEqual(400); // graceful failure

    await toxic.remove();
  });

  test('System handles Moonpay API down', async () => {
    const toxic = await moonpayProxy.addToxic(
      new toxiproxy.Toxic(moonpayProxy, {
        type: 'reset_peer',
      })
    );

    const res = await fetch('http://localhost:3000/api/v1/moonpay-rates');
    expect(res.status).toBeGreaterThanOrEqual(400);
    
    await toxic.remove();
  });
});
