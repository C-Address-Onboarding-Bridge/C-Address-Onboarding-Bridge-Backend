import { describe, it, expect, beforeAll } from 'vitest';

process.env.NODE_ENV = 'test';

import { register, httpRequestCounter, httpRequestDuration, activeRequestsGauge, circuitBreakerState } from '../services/metrics';

describe('metrics service', () => {
  it('register has default metrics', async () => {
    const output = await register.metrics();
    expect(typeof output).toBe('string');
    expect(output.length).toBeGreaterThan(0);
  });

  it('httpRequestCounter is a counter', async () => {
    httpRequestCounter.inc({ method: 'GET', path: '/health', status: '200' });
    const output = await register.metrics();
    expect(output).toContain('http_requests_total');
  });

  it('httpRequestDuration tracks latency buckets', async () => {
    httpRequestDuration.observe({ method: 'GET', path: '/health', status: '200' }, 0.05);
    const output = await register.metrics();
    expect(output).toContain('http_request_duration_seconds');
  });

  it('activeRequestsGauge can be incremented and decremented', async () => {
    activeRequestsGauge.inc();
    activeRequestsGauge.dec();
    const output = await register.metrics();
    expect(output).toContain('http_active_requests');
  });

  it('circuitBreakerState gauge works', async () => {
    circuitBreakerState.set({ service: 'soroban' }, 0);
    const output = await register.metrics();
    expect(output).toContain('circuit_breaker_state');
  });

  it('register content type is text/plain compatible', () => {
    expect(register.contentType).toContain('text/plain');
  });
});
