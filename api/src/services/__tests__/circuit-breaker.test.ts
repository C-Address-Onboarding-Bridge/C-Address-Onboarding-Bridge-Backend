import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../index', () => ({ logger: { warn: vi.fn(), info: vi.fn() } }));

import { CircuitBreaker, CircuitState, CircuitOpenError } from '../../circuit-breaker';

const fail = () => Promise.reject(new Error('service error'));
const succeed = () => Promise.resolve('ok');

describe('CircuitBreaker', () => {
  let cb: CircuitBreaker;

  beforeEach(() => {
    cb = new CircuitBreaker('test-service', { failureThreshold: 3, resetTimeout: 100, halfOpenMaxRequests: 2 });
  });

  it('opens after failureThreshold consecutive failures', async () => {
    expect(cb.getState()).toBe(CircuitState.CLOSED);
    for (let i = 0; i < 3; i++) {
      await expect(cb.execute(fail)).rejects.toThrow('service error');
    }
    expect(cb.getState()).toBe(CircuitState.OPEN);
  });

  it('fast-fails with CircuitOpenError when OPEN', async () => {
    for (let i = 0; i < 3; i++) await cb.execute(fail).catch(() => {});
    expect(cb.getState()).toBe(CircuitState.OPEN);
    await expect(cb.execute(succeed)).rejects.toBeInstanceOf(CircuitOpenError);
    const err = await cb.execute(succeed).catch((e) => e);
    expect(err.code).toBe('CIRCUIT_OPEN');
    expect(err.service).toBe('test-service');
  });

  it('transitions to HALF_OPEN after resetTimeout', async () => {
    for (let i = 0; i < 3; i++) await cb.execute(fail).catch(() => {});
    expect(cb.getState()).toBe(CircuitState.OPEN);
    await new Promise((r) => setTimeout(r, 110));
    // next execute should trigger HALF_OPEN transition
    await cb.execute(succeed).catch(() => {});
    expect(cb.getState()).toBe(CircuitState.HALF_OPEN);
  });

  it('closes after halfOpenMaxRequests successes in HALF_OPEN', async () => {
    for (let i = 0; i < 3; i++) await cb.execute(fail).catch(() => {});
    await new Promise((r) => setTimeout(r, 110));
    await cb.execute(succeed); // triggers HALF_OPEN, first success
    await cb.execute(succeed); // second success -> CLOSED
    expect(cb.getState()).toBe(CircuitState.CLOSED);
  });

  it('reopens on failure in HALF_OPEN', async () => {
    for (let i = 0; i < 3; i++) await cb.execute(fail).catch(() => {});
    await new Promise((r) => setTimeout(r, 110));
    await cb.execute(fail).catch(() => {});
    expect(cb.getState()).toBe(CircuitState.OPEN);
  });

  it('reports metrics correctly', async () => {
    await cb.execute(succeed);
    await cb.execute(fail).catch(() => {});
    const m = cb.getMetrics();
    expect(m.service).toBe('test-service');
    expect(m.state).toBe(CircuitState.CLOSED);
    expect(m.successCount).toBe(1);
    expect(m.failureCount).toBe(1);
    expect(m.lastFailureTime).toBeTypeOf('number');
  });
});
