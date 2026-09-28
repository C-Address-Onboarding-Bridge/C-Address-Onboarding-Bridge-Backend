import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { C_ADDRESS_REGEX } from '../utils/constants';
import { cexService } from '../services/cex';
import { exchangeRoutingCount } from '../services/metrics';

/** Express router for CEX withdrawal routing. Mounted at `/api/v1/cex`. */
export const cexRouter = Router();

/**
 * Scope required to trigger a withdrawal from the operator's exchange accounts.
 * This is intentionally NOT granted to legacy keys or normal keys by default:
 * withdrawals move real funds using the platform's exchange credentials, so only
 * callers explicitly holding `cex:withdraw` may reach the operator-credential
 * handlers (handleBinance /sapi/v1/capital/withdraw/apply, Coinbase, Kraken).
 */
export const CEX_WITHDRAW_SCOPE = 'cex:withdraw';

/**
 * Extract the scopes granted to the authenticated caller. The auth middleware
 * attaches the resolved API key (with its scopes) to `req.apiKey`; we also
 * accept `req.auth`/`req.scopes` shapes so the check works regardless of which
 * middleware populated the request. Legacy keys carry only `cex:read` and thus
 * never satisfy this check.
 */
function getCallerScopes(req: Request): string[] {
  const anyReq = req as Request & {
    apiKey?: { scopes?: unknown };
    auth?: { scopes?: unknown };
    scopes?: unknown;
  };
  const raw = anyReq.apiKey?.scopes ?? anyReq.auth?.scopes ?? anyReq.scopes;
  if (Array.isArray(raw)) {
    return raw.filter((s): s is string => typeof s === 'string');
  }
  if (typeof raw === 'string') {
    return raw.split(/[\s,]+/).filter(Boolean);
  }
  return [];
}

/**
 * Guard for the withdrawal route. Rejects any caller that does not hold the
 * explicit `cex:withdraw` scope with a 403 before any exchange credentials are
 * used. Read-only CEX endpoints are unaffected.
 */
export function requireCexWithdrawScope(req: Request, res: Response, next: NextFunction): void {
  const scopes = getCallerScopes(req);
  if (!scopes.includes(CEX_WITHDRAW_SCOPE)) {
    res.status(403).json({
      error: 'forbidden',
      message: `missing required scope: ${CEX_WITHDRAW_SCOPE}`,
    });
    return;
  }
  next();
}

const routeSchema = z.object({
  exchange: z.enum(['binance', 'coinbase', 'kraken', 'generic']),
  sourceAsset: z.string().min(1),
  amount: z.string().regex(/^\d+$/, 'amount must be an integer string (stroops)'),
  targetCAddress: z.string().regex(C_ADDRESS_REGEX, 'invalid target C-address'),
  targetNetwork: z.string().default('stellar'),
  memo: z.string().max(64).optional(),
});

/**
 * In-flight idempotency registry for withdrawal requests.
 *
 * Withdrawals are mutating operations and MUST NOT be served from a shared
 * response cache: a cache keyed only on the routing inputs would (a) return a
 * stale result for a second legitimate withdrawal with identical parameters
 * within the TTL and (b) leak one tenant's withdrawal id to another API key
 * sending the same parameters. Instead we de-duplicate only *concurrent*
 * identical requests from the same caller, and drop the entry as soon as the
 * exchange call settles so subsequent requests always hit the exchange.
 */
const inFlightWithdrawals = new Map<string, Promise<Awaited<ReturnType<typeof cexService.routeWithdrawal>>>>();

/**
 * Build an idempotency key scoped to the authenticated caller so that two
 * different API keys can never observe each other's withdrawal results.
 */
function buildIdempotencyKey(req: Request, body: z.infer<typeof routeSchema>): string {
  const anyReq = req as Request & {
    apiKey?: { id?: unknown; key?: unknown };
    auth?: { apiKeyId?: unknown; id?: unknown };
  };
  const caller =
    anyReq.apiKey?.id ??
    anyReq.apiKey?.key ??
    anyReq.auth?.apiKeyId ??
    anyReq.auth?.id ??
    'anonymous';
  return [
    String(caller),
    body.exchange,
    body.sourceAsset,
    body.amount,
    body.targetCAddress,
    body.targetNetwork,
  ].join(':');
}

cexRouter.post('/route', requireCexWithdrawScope, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = routeSchema.parse(req.body);

    const idempotencyKey = buildIdempotencyKey(req, body);

    // De-duplicate only concurrent identical requests from the same caller.
    // The entry is removed once the exchange call settles, so a later
    // legitimate withdrawal with the same parameters is always re-executed.
    let pending = inFlightWithdrawals.get(idempotencyKey);
    if (!pending) {
      pending = cexService.routeWithdrawal(body);
      inFlightWithdrawals.set(idempotencyKey, pending);
      pending.finally(() => {
        inFlightWithdrawals.delete(idempotencyKey);
      });
    }

    const result = await pending;

    // routeWithdrawal can resolve with {status: 'failed', ...} when the exchange API fails.
    // Surface that as a 502 so callers don't treat a failed withdrawal as created.
    if (result.status === 'failed') {
      exchangeRoutingCount.inc({ exchange: body.exchange, status: 'failed' });
      res.status(502).json(result);
      return;
    }

    exchangeRoutingCount.inc({ exchange: body.exchange, status: 'success' });
    res.status(201).json(result);
  } catch (err) {
    const exchange = (req.body as { exchange?: string })?.exchange ?? 'unknown';
    exchangeRoutingCount.inc({ exchange, status: 'failed' });
    next(err);
  }
});
