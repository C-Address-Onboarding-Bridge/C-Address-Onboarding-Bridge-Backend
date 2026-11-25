// Issues #1010, #1011, #1012, #1013 - Final Critical Fixes

// Issue #1013: Fix rebate lookup to use sourceAddress
export async function getQuote(
  sourceAsset: string,
  amount: string,
  sourceAddress: string, // FIX: Use for rebate, not targetAddress
): Promise<{ fee: string; feeBps: number; rebateBps: number }> {
  const { feeBps, rebateBps } = await this.getContractFeeBps(sourceAddress);
  return { fee, feeBps, rebateBps };
}

// In quote.ts - FIX: Pass sourceAddress, not targetAddress
const quote = await sorobanService.getQuote(
  params.sourceAsset,
  params.amount,
  params.sourceAddress, // FIX: Correct parameter
);

// FIX: SWR revalidator uses same parameters
async function computeQuote(req: Request) {
  const params = getQuoteSchema.parse(req.query);
  const quote = await sorobanService.getQuote(
    params.sourceAsset,
    params.amount,
    params.sourceAddress, // FIX: Include sourceAddress
  );
}

// Issue #1012: Mark cache responses as private, not public
export function cacheMiddleware(opts: CacheOpts) {
  return (req: Request, res: Response, next: NextFunction) => {
    // ... cache lookup ...

    // FIX: Mark as private since response depends on API key
    res.setHeader('Cache-Control', `private, max-age=${ttl}`);

    // FIX: Age calculation per RFC 9111
    const age = Math.floor((Date.now() - entry.cachedAt) / 1000);
    res.setHeader('Age', String(age));
  };
}

// Issue #1011: Read status/body from cached entry, not wrapper
export function cacheMiddleware(opts: CacheOpts) {
  return (req: Request, res: Response, next: NextFunction) => {
    const cached = cache.get(cacheKey);

    if (cached) {
      const entry = cached.value; // FIX: Correct reference
      const isStale = cached.stale;

      // FIX: Use entry.status and entry.body
      res.status(entry.status).json(entry.body);

      if (isStale) {
        void revalidate(req, cacheKey, ttl, opts.revalidate);
      }

      return;
    }

    next();
  };
}

// Issue #1010: Return 501 for unimplemented direct funding
export async function submitDirectFunding(
  sourceAddress: string,
  targetAddress: string,
  tokenAddress: string,
  amount: string,
  memo?: string,
): Promise<never> {
  // FIX: Return 501 Not Implemented
  throw new ApiError(501, 'Direct funding not implemented', 'not_implemented');
}

// In funding.ts route handler - FIX: Catch unimplemented and return 501
try {
  const result = await sorobanService.submitDirectFunding(...);
  res.json(result);
} catch (err) {
  if (err instanceof ApiError && err.status === 501) {
    res.status(501).json({ error: err.message });
  } else {
    next(err);
  }
}
