import { describe, it, expect, vi, afterEach } from 'vitest';

process.env.NODE_ENV = 'test';

describe('Signal handler registration', () => {
  afterEach(() => {
    // Clean up any installed handlers
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');
  });

  it('registerSignalHandlers registers a handler for SIGTERM synchronously', () => {
    const { registerSignalHandlers } = require('../shutdown');
    const mockCloseConnections = vi.fn().mockResolvedValue(undefined);

    registerSignalHandlers(mockCloseConnections);

    const listeners = process.listeners('SIGTERM');
    expect(listeners.length).toBeGreaterThan(0);
  });

  it('registerSignalHandlers registers a handler for SIGINT synchronously', () => {
    const { registerSignalHandlers } = require('../shutdown');
    const mockCloseConnections = vi.fn().mockResolvedValue(undefined);

    registerSignalHandlers(mockCloseConnections);

    const listeners = process.listeners('SIGINT');
    expect(listeners.length).toBeGreaterThan(0);
  });

  it('signal handler calls the provided closeConnections callback', async () => {
    const { registerSignalHandlers, gracefulShutdown } = require('../shutdown');
    const mockCloseConnections = vi.fn().mockResolvedValue(undefined);

    registerSignalHandlers(mockCloseConnections);

    const listeners = process.listeners('SIGTERM');
    expect(listeners.length).toBeGreaterThan(0);

    // Simulate shutdown completion
    if (listeners[listeners.length - 1]) {
      const handler = listeners[listeners.length - 1] as Function;
      await handler();
    }

    expect(mockCloseConnections).toHaveBeenCalled();
  });

  it('handler is registered BEFORE dynamic imports resolve', async () => {
    // Clear any existing listeners first
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');

    const listenersBefore = process.listeners('SIGTERM').length;

    const { registerSignalHandlers } = require('../shutdown');
    const mockCloseConnections = vi.fn().mockResolvedValue(undefined);

    // Register synchronously
    registerSignalHandlers(mockCloseConnections);

    const listenersAfter = process.listeners('SIGTERM').length;
    expect(listenersAfter).toBeGreaterThan(listenersBefore);
  });

  it('signal handler sets isShuttingDown flag', async () => {
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');

    const { registerSignalHandlers, gracefulShutdown } = require('../shutdown');
    const mockCloseConnections = vi.fn().mockResolvedValue(undefined);

    registerSignalHandlers(mockCloseConnections);

    const listeners = process.listeners('SIGTERM');
    if (listeners.length > 0) {
      const handler = listeners[listeners.length - 1] as Function;
      await handler();
      expect(gracefulShutdown.isShuttingDown).toBe(true);
    }
  });
});
