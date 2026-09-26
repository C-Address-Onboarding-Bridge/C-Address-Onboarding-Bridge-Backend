import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { C_ADDRESS_REGEX } from '../utils/constants';
import { cexService } from '../services/cex';
import { exchangeRoutingCount } from '../services/metrics';
import { buildCacheKey, CACHE_TTL, getOrCompute, cacheDel } from '../services/cache';

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

cexRouter.post('/route', requireCexWithdrawScope, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = routeSchema.parse(req.body);

    // Cache key covers all deterministic routing inputs; memo is intentionally
    // excluded because it is a caller-supplied label that doesn't affect routing.
    const cacheKey = buildCacheKey(
      'cex',
      `${body.exchange}:${body.sourceAsset}:${body.amount}:${body.targetCAddress}:${body.targetNetwork}`,
    );

    // routeWithdrawal can resolve with {status: 'failed', ...} when the exchange API fails.
    // We only cache successful results to avoid poisoning the cache with transient failures.
    const result = await getOrCompute(
      cacheKey,
      CACHE_TTL.cex,
      () => cexService.routeWithdrawal(body),
    );

    // If the result indicates failure, don't use the cached value and retry next time.
    if (result.status === 'failed') {
      // Clear this cache entry so the next request will retry the exchange API.
      // Use setImmediate to avoid blocking the response.
      setImmediate(() => {
        cacheDel(cacheKey).catch(() => {
          // Errors in cache deletion don't affect the client response.
        });
      });
      exchangeRoutingCount.inc({ exchange: body.exchange, status: 'failed' });
      res.status(201).json(result);
      return;
    }

    exchangeRoutingCount.inc({ exchange: body.exchange, status: 'success' });
    res.setHeader('X-Cache', res.getHeader('X-Cache') ?? 'MISS');
    res.status(201).json(result);
  } catch (err) {
    const exchange = (req.body as { exchange?: string })?.exchange ?? 'unknown';
    exchangeRoutingCount.inc({ exchange, status: 'failed' });
    next(err);
  }
});
