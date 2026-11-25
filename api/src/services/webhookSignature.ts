import crypto from 'node:crypto';

/**
 * Canonical outgoing webhook header format (issues #1060 and #1061).
 *
 * Every webhook delivery - whether it is the first attempt from the API
 * process (webhookDelivery.ts) or a retry from the BullMQ worker
 * (webhookRetry.ts) - MUST produce headers via buildWebhookHeaders() and
 * sign the body via computeWebhookSignature(). This is the only way a
 * receiver can use a single verification rule for every delivery.
 *
 * Wire contract:
 *   POST <your-endpoint>
 *   Content-Type: application/json
 *   X-Webhook-Signature: sha256=<hex HMAC-SHA256>
 *   X-Webhook-Timestamp: <unix SECONDS, integer>
 *   X-Webhook-Event: <event name>
 *   X-Webhook-Attempt: <1-indexed integer>
 *   X-Webhook-Id: <uuid, stable across every attempt of one delivery>
 *
 *   Signed message: `${X-Webhook-Timestamp}.${rawRequestBody}`
 *
 * The receiver MUST:
 *   1. Reject if |nowSeconds - X-Webhook-Timestamp| > 300 (replay window).
 *   2. Compute HMAC-SHA256(secret, `${timestampSeconds}.${rawBody}`).
 *   3. Compare against the hex after `sha256=` with timingSafeEqual.
 *   4. Dedupe on X-Webhook-Id (same value for every retry of one delivery).
 *
 * The timestamp is refreshed on every attempt (issue #1061), so a late retry
 * still passes the replay window and its signature verifies against the
 * timestamp header the receiver sees.
 */

export const WEBHOOK_SIGNATURE_HEADER = 'X-Webhook-Signature' as const;
export const WEBHOOK_TIMESTAMP_HEADER = 'X-Webhook-Timestamp' as const;
export const WEBHOOK_EVENT_HEADER = 'X-Webhook-Event' as const;
export const WEBHOOK_ATTEMPT_HEADER = 'X-Webhook-Attempt' as const;
export const WEBHOOK_ID_HEADER = 'X-Webhook-Id' as const;
export const WEBHOOK_SIGNATURE_PREFIX = 'sha256=' as const;
export const WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 300;

export interface WebhookHeaderParams {
  /** Event name delivered in the payload (e.g. "funding.submitted"). */
  event: string;
  /** Unix timestamp in SECONDS. Use toUnixSeconds(Date.now()) to derive. */
  timestampSeconds: number;
  /** Bare hex HMAC-SHA256 of `${timestampSeconds}.${rawBody}`. */
  signatureHex: string;
  /** 1-indexed attempt number. First delivery is 1, first retry is 2, etc. */
  attempt: number;
  /**
   * Stable identifier for one logical delivery (issue #1061). Same value on
   * every attempt of the same event so receivers can dedupe across retries.
   */
  webhookId: string;
}

/** Convert a JS millisecond timestamp (e.g. Date.now()) to unix seconds. */
export function toUnixSeconds(ms: number): number {
  return Math.floor(ms / 1000);
}

/** Build the exact string covered by the HMAC. */
export function signedWebhookMessage(timestampSeconds: number, rawBody: string): string {
  return `${timestampSeconds}.${rawBody}`;
}

/** Compute the bare hex HMAC-SHA256 signature for a payload. */
export function computeWebhookSignature(
  secret: string,
  timestampSeconds: number,
  rawBody: string,
): string {
  return crypto
    .createHmac('sha256', secret)
    .update(signedWebhookMessage(timestampSeconds, rawBody))
    .digest('hex');
}

/**
 * Build the canonical outbound headers. This is the ONLY function that
 * composes the wire format - both the first attempt and retries call it so
 * the headers are guaranteed byte-identical in shape.
 */
export function buildWebhookHeaders(params: WebhookHeaderParams): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    [WEBHOOK_SIGNATURE_HEADER]: `${WEBHOOK_SIGNATURE_PREFIX}${params.signatureHex}`,
    [WEBHOOK_TIMESTAMP_HEADER]: String(params.timestampSeconds),
    [WEBHOOK_EVENT_HEADER]: params.event,
    [WEBHOOK_ATTEMPT_HEADER]: String(params.attempt),
    [WEBHOOK_ID_HEADER]: params.webhookId,
  };
}

/**
 * Reference verifier used by tests and copied verbatim into docs. Not used in
 * production (the API only sends webhooks); kept here so the doc example has a
 * single source of truth that stays in sync with the producer.
 */
export function verifyWebhookSignature(params: {
  secret: string;
  rawBody: string;
  headers: Record<string, string | string[] | undefined>;
  toleranceSeconds?: number;
  now?: number;
}): boolean {
  const signatureHeader = firstHeader(params.headers, WEBHOOK_SIGNATURE_HEADER);
  const timestampHeader = firstHeader(params.headers, WEBHOOK_TIMESTAMP_HEADER);
  if (!signatureHeader || !timestampHeader) return false;
  if (!signatureHeader.startsWith(WEBHOOK_SIGNATURE_PREFIX)) return false;

  const receivedHex = signatureHeader.slice(WEBHOOK_SIGNATURE_PREFIX.length);
  const timestampSeconds = Number(timestampHeader);
  if (!Number.isInteger(timestampSeconds)) return false;

  const tolerance = params.toleranceSeconds ?? WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS;
  const now = params.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestampSeconds) > tolerance) return false;

  const expectedHex = computeWebhookSignature(params.secret, timestampSeconds, params.rawBody);
  if (receivedHex.length !== expectedHex.length) return false;
  return crypto.timingSafeEqual(Buffer.from(receivedHex, 'hex'), Buffer.from(expectedHex, 'hex'));
}

function firstHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) {
      const value = headers[key];
      return Array.isArray(value) ? value[0] : value;
    }
  }
  return undefined;
}
