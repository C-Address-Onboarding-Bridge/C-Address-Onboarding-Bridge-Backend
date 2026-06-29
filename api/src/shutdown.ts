import { Server } from 'http';
import { config } from './config';

type Logger = { info: (_obj: unknown, _msg?: string) => void; warn: (_obj: unknown, _msg?: string) => void };

export class GracefulShutdown {
  private activeRequests = 0;
  isShuttingDown = false;
  private server: Server | null = null;
  private shutdownResolve: (() => void) | null = null;
  private logger: Logger | null = null;
  private readonly timeoutMs: number;

  constructor(timeoutMs?: number) {
    this.timeoutMs = timeoutMs ?? config.shutdown.timeoutMs;
  }

  get shuttingDown(): boolean {
    return this.isShuttingDown;
  }

  get requestCount(): number {
    return this.activeRequests;
  }

  attach(server: Server, logger: Logger): void {
    this.server = server;
    this.logger = logger;
  }

  increment(): void {
    this.activeRequests++;
  }

  decrement(): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    if (this.isShuttingDown && this.activeRequests === 0) {
      this.shutdownResolve?.();
    }
  }

  async shutdown(closeConnections: () => Promise<void> = async () => {}): Promise<void> {
    if (this.isShuttingDown) return;

    this.isShuttingDown = true;
    this.logger?.info({ activeRequests: this.activeRequests }, 'graceful shutdown: stopping new requests');

    this.server?.close(() => {
      this.logger?.info('graceful shutdown: http server closed');
    });

    if (this.activeRequests > 0) {
      this.logger?.info({ activeRequests: this.activeRequests }, 'graceful shutdown: draining active requests');

      await new Promise<void>((resolve) => {
        this.shutdownResolve = resolve;
        setTimeout(() => {
          this.logger?.warn(
            { activeRequests: this.activeRequests, timeoutMs: this.timeoutMs },
            'graceful shutdown: timeout reached, forcing exit',
          );
          resolve();
        }, this.timeoutMs);
      });
    }

    this.logger?.info('graceful shutdown: closing connections');
    await closeConnections();
    this.logger?.info('graceful shutdown: complete');
  }
}

export const gracefulShutdown = new GracefulShutdown();

export function registerSignalHandlers(closeConnections: () => Promise<void>): void {
  const shutdown = async (signal: string) => {
    gracefulShutdown['logger']?.info({ signal }, 'signal received');
    await gracefulShutdown.shutdown(closeConnections);
    process.exit(0);
  };

  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}
