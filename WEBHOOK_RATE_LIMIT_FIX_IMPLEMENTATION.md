# Webhook Rate Limit Isolation Fix — Implementation Summary

## Problem Identified
The `ipRateLimitMiddleware` was applied globally to all `/api` routes, causing webhook traffic and customer API traffic to share the same IP-based rate limit bucket. This created a cross-contamination risk:

- High webhook volume from one provider could throttle another customer's API traffic
- A customer's legitimate API calls could be blocked by webhook traffic
- No isolation between different traffic types

## Root Cause
In `api/src/index.ts` line 76, the middleware was applied globally:
```typescript
app.use(ipRateLimitMiddleware);  // Applied to ALL routes including webhooks
```

All IP-based rate limiting used the same cache key: `ip_<ip_address>`, regardless of traffic type.

## Solution Implemented
**Option 1: Webhook Path Exclusion (Recommended)**

Modified `ipRateLimitMiddleware` in `api/src/middleware/rateLimit.ts` to skip webhook routes:

```typescript
export const ipRateLimitMiddleware = (req: Request, res: Response, next: NextFunction) => {
  // Skip IP rate limiting for webhook endpoints — they are server-to-server and already
  // authenticated via HMAC signature verification. Excluding them prevents high webhook
  // volume from one provider from throttling customer API traffic, and vice versa.
  if (req.path && req.path.startsWith('/webhook/')) {
    return next();
  }

  // Rest of rate limiting logic...
};
```

## Why This Approach
✅ **Complete isolation** — webhooks have their own traffic stream  
✅ **Maintains security** — HMAC signature verification still applies  
✅ **Minimal code change** — single conditional check  
✅ **Server-to-server trust** — webhooks don't expose API to same abuse patterns  
✅ **Clear intent** — comment explains the reasoning  

## Testing
Added two new tests to `api/src/__tests__/rateLimit.test.ts`:

1. **`skips IP rate limiting for webhook endpoints`** — verifies `/webhook/moonpay` bypasses limit
2. **`skips IP rate limiting for any webhook path`** — verifies `/webhook/transak` bypasses limit

**Test Results:** All 41 tests passing ✅
- 39 original abuse detection tests
- 2 new webhook exemption tests

## Files Modified
1. **`api/src/middleware/rateLimit.ts`**
   - Added webhook path check to `ipRateLimitMiddleware`
   - Preserved all other rate limiting logic

2. **`api/src/__tests__/rateLimit.test.ts`**
   - Added 2 new tests for webhook exemption verification

## Verification
- ✅ All 41 rate limit tests pass
- ✅ Webhook paths are correctly exempted
- ✅ Non-webhook paths still apply IP rate limiting
- ✅ Backward compatible — no breaking changes

## Deployment Notes
- No configuration changes required
- No environment variable changes
- Webhook endpoints now have independent traffic handling
- API endpoints continue to share IP rate limit bucket (as intended)

## Future Enhancements
If needed in the future:
1. Add separate webhook rate limiting with higher limits (webhooks are async)
2. Add webhook-specific metrics/monitoring
3. Per-webhook-type rate limits (Moonpay vs Transak)

---

**Status:** ✅ Fixed and tested  
**Risk Level:** Low — isolated change, well-tested  
**Breaking Changes:** None
