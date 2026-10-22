import { Request, Response, NextFunction } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';

const MAX_CLOCK_SKEW_SECONDS = 300;

/**
 * Serialize a query object into a stable, sorted `key=value&...` string.
 * Mirrors the SDK's serialization so both sides compute the same payload.
 */
function serializeSortedQuery(query: Record<string, unknown> | undefined): string {
  if (!query) {
    return '';
  }
  const keys = Object.keys(query).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const value = query[key];
    if (value === undefined || value === null) {
      continue;
    }
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.join('&');
}

/**
 * Build the canonical signing payload. Must stay in sync with the SDK's
 * `buildSigningPayload` in sdk/src/bridge.ts.
 */
export function buildSigningPayload(
  method: string,
  path: string,
  query: Record<string, unknown> | undefined,
  bodyStr: string,
  timestamp: string,
  nonce: string
): string {
  const sortedQuery = serializeSortedQuery(query);
  return `${method.toUpperCase()}.${path}.${sortedQuery}.${bodyStr}.${timestamp}.${nonce}`;
}

export function requestSigningMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const signature = req.header('X-Signature');
  const timestamp = req.header('X-Timestamp');
  const nonce = req.header('X-Nonce');

  if (!signature || !timestamp || !nonce) {
    res.status(401).json({ error: 'missing_signature' });
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > MAX_CLOCK_SKEW_SECONDS) {
    res.status(401).json({ error: 'invalid_timestamp' });
    return;
  }

  const secret = process.env.REQUEST_SIGNING_SECRET;
  if (!secret) {
    res.status(500).json({ error: 'signing_not_configured' });
    return;
  }

  // Canonical body: empty string for bodiless requests (e.g. GETs), matching
  // the SDK. express.json() sets req.body = {} on bodiless requests, so we
  // must not stringify that into "{}".
  const hasBody =
    req.body !== undefined &&
    req.body !== null &&
    !(typeof req.body === 'object' && Object.keys(req.body).length === 0);
  const bodyStr = hasBody
    ? typeof req.body === 'string'
      ? req.body
      : JSON.stringify(req.body)
    : '';

  const path = req.path;
  const payload = buildSigningPayload(
    req.method,
    path,
    req.query as Record<string, unknown>,
    bodyStr,
    timestamp,
    nonce
  );

  const expected = createHmac('sha256', secret).update(payload).digest('hex');

  const expectedBuf = Buffer.from(expected, 'hex');
  const providedBuf = Buffer.from(signature, 'hex');
  if (
    expectedBuf.length !== providedBuf.length ||
    !timingSafeEqual(expectedBuf, providedBuf)
  ) {
    res.status(401).json({ error: 'invalid_signature' });
    return;
  }

  next();
}
