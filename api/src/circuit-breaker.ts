import { logger } from './index';

export enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

export class CircuitOpenError extends Error {
  readonly code = 'CIRCUIT_OPEN';
  readonly service: string;
  constructor(service: string) {
    super(`Circuit breaker OPEN for service: ${service}`);
    this.name = 'CircuitOpenError';
    this.service = service;
  }
}

interface CircuitBreakerConfig {
  failureThreshold?: number;
  resetTimeout?: number;
  halfOpenMaxRequests?: number;
}

export class CircuitBreaker {
  private state = CircuitState.CLOSED;
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime: number | null = null;
  private halfOpenRequests = 0;

  private readonly failureThreshold: number;
  private readonly resetTimeout: number;
  private readonly halfOpenMaxRequests: number;

  constructor(private readonly service: string, config: CircuitBreakerConfig = {}) {
    this.failureThreshold = config.failureThreshold ?? 5;
    this.resetTimeout = config.resetTimeout ?? 30_000;
    this.halfOpenMaxRequests = config.halfOpenMaxRequests ?? 3;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === CircuitState.OPEN) {
      if (Date.now() - this.lastFailureTime! >= this.resetTimeout) {
        this.transition(CircuitState.HALF_OPEN);
      } else {
        throw new CircuitOpenError(this.service);
      }
    }

    if (this.state === CircuitState.HALF_OPEN && this.halfOpenRequests >= this.halfOpenMaxRequests) {
      throw new CircuitOpenError(this.service);
    }

    if (this.state === CircuitState.HALF_OPEN) {
      this.halfOpenRequests++;
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  private onSuccess(): void {
    this.successCount++;
    if (this.state === CircuitState.HALF_OPEN) {
      const halfOpenSuccesses = this.halfOpenRequests - this.failureCount;
      if (halfOpenSuccesses >= this.halfOpenMaxRequests) {
        this.failureCount = 0;
        this.halfOpenRequests = 0;
        this.transition(CircuitState.CLOSED);
      }
    } else {
      this.failureCount = 0;
    }
  }

  private onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    if (this.state === CircuitState.HALF_OPEN) {
      this.halfOpenRequests = 0;
      this.transition(CircuitState.OPEN);
    } else if (this.state === CircuitState.CLOSED && this.failureCount >= this.failureThreshold) {
      this.transition(CircuitState.OPEN);
    }
  }

  private transition(next: CircuitState): void {
    logger.warn({ service: this.service, from: this.state, to: next }, 'circuit breaker state transition');
    this.state = next;
    if (next === CircuitState.HALF_OPEN) {
      this.halfOpenRequests = 0;
      this.failureCount = 0;
    }
  }

  getState(): CircuitState {
    return this.state;
  }

  getMetrics() {
    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      lastFailureTime: this.lastFailureTime,
      service: this.service,
    };
  }
}
