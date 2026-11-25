import { describe, it, expect } from 'vitest';
import {
  buildWebhookHeaders,
  computeWebhookSignature,
  signedWebhookMessage,
  toUnixSeconds,
  verifyWebhookSignature,
  WEBHOOK_ATTEMPT_HEADER,
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_ID_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
} from '../services/webhookSignature';

const SECRET = 'this-is-a-32-character-secret!!!';
const WEBHOOK_ID = 'whk-11111111-2222-3333-4444-555555555555';

describe('webhookSignature', () => {
  describe('buildWebhookHeaders', () => {
    it('produces the canonical header set', () => {
      const headers = buildWebhookHeaders({
        event: 'funding.submitted',
        timestampSeconds: 1_700_000_000,
        signatureHex: 'a'.repeat(64),
        attempt: 1,
        webhookId: WEBHOOK_ID,
      });
      expect(headers).toEqual({
        'Content-Type': 'application/json',
        [WEBHOOK_SIGNATURE_HEADER]: `sha256=${'a'.repeat(64)}`,
        [WEBHOOK_TIMESTAMP_HEADER]: '1700000000',
        [WEBHOOK_EVENT_HEADER]: 'funding.submitted',
        [WEBHOOK_ATTEMPT_HEADER]: '1',
        [WEBHOOK_ID_HEADER]: WEBHOOK_ID,
      });
    });

    it('produces byte-identical header format for attempt 1 and a retry', () => {
      // Issues #1060 and #1061: receivers must verify every delivery with one
      // rule and dedupe via X-Webhook-Id. This test pins the wire format for
      // the first attempt and a retry with the same webhookId.
      const shared = {
        event: 'funding.submitted',
        timestampSeconds: 1_700_000_000,
        signatureHex: 'a'.repeat(64),
        webhookId: WEBHOOK_ID,
      };
      const first = buildWebhookHeaders({ ...shared, attempt: 1 });
      const retry = buildWebhookHeaders({ ...shared, attempt: 2 });

      expect(Object.keys(first).sort()).toEqual(Object.keys(retry).sort());

      const sigPattern = /^sha256=[a-f0-9]{64}$/;
      const tsPattern = /^\d{10}$/;
      for (const headers of [first, retry]) {
        expect(headers[WEBHOOK_SIGNATURE_HEADER]).toMatch(sigPattern);
        expect(headers[WEBHOOK_TIMESTAMP_HEADER]).toMatch(tsPattern);
        expect(headers[WEBHOOK_EVENT_HEADER]).toBe('funding.submitted');
        expect(headers[WEBHOOK_ATTEMPT_HEADER]).toMatch(/^\d+$/);
        expect(headers[WEBHOOK_ID_HEADER]).toBe(WEBHOOK_ID);
      }

      // Stable fields are identical across attempts.
      expect(first[WEBHOOK_SIGNATURE_HEADER]).toBe(retry[WEBHOOK_SIGNATURE_HEADER]);
      expect(first[WEBHOOK_TIMESTAMP_HEADER]).toBe(retry[WEBHOOK_TIMESTAMP_HEADER]);
      expect(first[WEBHOOK_ID_HEADER]).toBe(retry[WEBHOOK_ID_HEADER]);
      // Only the attempt counter changes.
      expect(first[WEBHOOK_ATTEMPT_HEADER]).toBe('1');
      expect(retry[WEBHOOK_ATTEMPT_HEADER]).toBe('2');
    });

    it('emits different X-Webhook-Id values for different deliveries', () => {
      const a = buildWebhookHeaders({
        event: 'funding.submitted',
        timestampSeconds: 1_700_000_000,
        signatureHex: 'a'.repeat(64),
        attempt: 1,
        webhookId: 'whk-aaaaaaaa-1111-2222-3333-444444444444',
      });
      const b = buildWebhookHeaders({
        event: 'funding.submitted',
        timestampSeconds: 1_700_000_000,
        signatureHex: 'a'.repeat(64),
        attempt: 1,
        webhookId: 'whk-bbbbbbbb-1111-2222-3333-444444444444',
      });
      expect(a[WEBHOOK_ID_HEADER]).not.toBe(b[WEBHOOK_ID_HEADER]);
    });
  });

  describe('computeWebhookSignature', () => {
    it('is deterministic and hex-encoded', () => {
      const a = computeWebhookSignature(SECRET, 1_700_000_000, '{"event":"x"}');
      const b = computeWebhookSignature(SECRET, 1_700_000_000, '{"event":"x"}');
      expect(a).toBe(b);
      expect(a).toMatch(/^[a-f0-9]{64}$/);
    });

    it('signs the string `${timestamp}.${body}`', () => {
      expect(signedWebhookMessage(1_700_000_000, '{"event":"x"}')).toBe('1700000000.{"event":"x"}');
    });

    it('changes when the timestamp changes', () => {
      const a = computeWebhookSignature(SECRET, 1_700_000_000, '{}');
      const b = computeWebhookSignature(SECRET, 1_700_000_001, '{}');
      expect(a).not.toBe(b);
    });
  });

  describe('verifyWebhookSignature', () => {
    const body = '{"event":"funding.submitted","data":{}}';
    const timestampSeconds = 1_700_000_000;

    function validHeaders(sigHex: string) {
      return {
        'x-webhook-signature': `sha256=${sigHex}`,
        'x-webhook-timestamp': String(timestampSeconds),
        'x-webhook-id': WEBHOOK_ID,
      };
    }

    it('accepts a valid signature', () => {
      const sig = computeWebhookSignature(SECRET, timestampSeconds, body);
      expect(
        verifyWebhookSignature({
          secret: SECRET,
          rawBody: body,
          headers: validHeaders(sig),
          now: timestampSeconds,
        }),
      ).toBe(true);
    });

    it('accepts both first-attempt and retry header sets', () => {
      // Attempt-specific headers never change the verification result - this
      // proves the documented verifier handles every delivery identically.
      const sig = computeWebhookSignature(SECRET, timestampSeconds, body);
      const headers = validHeaders(sig);
      for (const attempt of [1, 2, 3]) {
        expect(
          verifyWebhookSignature({
            secret: SECRET,
            rawBody: body,
            headers: { ...headers, 'x-webhook-attempt': String(attempt) },
            now: timestampSeconds,
          }),
        ).toBe(true);
      }
    });

    it('rejects a tampered body', () => {
      const sig = computeWebhookSignature(SECRET, timestampSeconds, body);
      expect(
        verifyWebhookSignature({
          secret: SECRET,
          rawBody: body + ' ',
          headers: validHeaders(sig),
          now: timestampSeconds,
        }),
      ).toBe(false);
    });

    it('rejects a stale timestamp', () => {
      const sig = computeWebhookSignature(SECRET, timestampSeconds, body);
      expect(
        verifyWebhookSignature({
          secret: SECRET,
          rawBody: body,
          headers: validHeaders(sig),
          now: timestampSeconds + 3_600,
        }),
      ).toBe(false);
    });

    it('rejects a signature without the sha256= prefix', () => {
      const sig = computeWebhookSignature(SECRET, timestampSeconds, body);
      expect(
        verifyWebhookSignature({
          secret: SECRET,
          rawBody: body,
          headers: {
            'x-webhook-signature': sig,
            'x-webhook-timestamp': String(timestampSeconds),
          },
          now: timestampSeconds,
        }),
      ).toBe(false);
    });

    it('rejects when required headers are missing', () => {
      expect(
        verifyWebhookSignature({
          secret: SECRET,
          rawBody: body,
          headers: {},
          now: timestampSeconds,
        }),
      ).toBe(false);
    });
  });

  describe('toUnixSeconds', () => {
    it('truncates milliseconds to seconds', () => {
      expect(toUnixSeconds(1_700_000_000_999)).toBe(1_700_000_000);
      expect(toUnixSeconds(1_700_000_000)).toBe(1_700_000_000);
    });
  });
});
