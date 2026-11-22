import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildSigningHeaders,
  ClockSkewTracker,
  DEFAULT_CLOCK_SKEW_TOLERANCE_MS,
} from '../src/bridge';

describe('ClockSkewTracker', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('defaults to the API TIMESTAMP_WINDOW_MS tolerance', () => {
    expect(DEFAULT_CLOCK_SKEW_TOLERANCE_MS).toBe(300_000);
  });

  it('applies the server offset to the signing timestamp', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));

    const tracker = new ClockSkewTracker();
    // Server is 10 minutes ahead of the local clock.
    tracker.observeDateHeader('Mon, 01 Jan 2024 00:10:00 GMT');

    expect(tracker.getOffsetMs()).toBe(600_000);

    const headers = buildSigningHeaders('GET', '/v1/health', '', 'secret', tracker);
    expect(headers['X-Timestamp']).toBe(String(Date.parse('2024-01-01T00:10:00.000Z')));
  });

  it('ignores offsets within the tolerance window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));

    const tracker = new ClockSkewTracker();
    tracker.observeDateHeader('Mon, 01 Jan 2024 00:00:10 GMT');

    expect(tracker.getOffsetMs()).toBe(0);
  });

  it('ignores missing or invalid Date headers', () => {
    const tracker = new ClockSkewTracker();
    tracker.observeDateHeader(null);
    tracker.observeDateHeader('not-a-date');
    expect(tracker.getOffsetMs()).toBe(0);
  });

  it('falls back to Date.now() when no tracker is provided', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));

    const headers = buildSigningHeaders('GET', '/v1/health', '', 'secret');
    expect(headers['X-Timestamp']).toBe(String(Date.now()));
  });
});
