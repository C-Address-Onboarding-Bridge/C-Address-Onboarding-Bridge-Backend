# Webhook Rate Limit Isolation Issue

## Problem
Webhooks (`POST /api/webhook/moonpay` and `POST /api/webhook/transak`) and customer API calls share the same IP-keyed rate limit bucket because `ipRateLimitMiddleware` is applied globally at `app.use('/api', ipRateLimitMiddleware)`.

**Impact:**
- High webhook volume from one provider could throttle another customer's API traffic
- A legitimate customer's API calls could be blocked by webhook traffic
- No isolation between webhook endpoints and API endpoints

## Root Cause
In `api/src/index.ts` (line 76):
```typescript
app.use(ipRateLimitMiddleware);  // Applied globally to ALL /api routes
```

Then webhooks are mounted after tier limiting:
```typescript
app.use('/api/webhook/moonpay', moonpayWebhookRouter);
app.use('/api/webhook/transak', transakWebhookRouter);
```

The `ipRateLimitMiddleware` uses IP-derived keys: `ip_<ip_address>`, so all traffic from the same IP (whether webhook or API) competes for the same limit.

## Solution Options

### Option 1: Exclude Webhooks from IP Rate Limiting (Recommended)
Modify the IP rate limit middleware to skip webhook routes:

**Changes to `middleware/rateLimit.ts`:**
```typescript
export const ipRateLimitMiddleware = (req: Request, res: Response, next: NextFunction) => {
  // Skip IP rate limiting for webhooks — they have their own verification
  if (req.path.startsWith('/webhook/')) {
    return next();
  }

  const ip = req.ip ?? 'unknown';
  if (isIPBanned(ip)) {
    res.status(403).json({ error: 'forbidden', message: 'IP temporarily banned due to suspicious activity' });
    return;
  }
  ipLimiter(req, res, next);
};
```

**Rationale:**
- Webhooks are already authenticated via HMAC signature verification (`webhookVerification` middleware)
- Webhooks don't expose the API to the same abuse patterns (they're server-to-server)
- Isolates webhook traffic from customer API rate limits

### Option 2: Separate Webhook Rate Limiter
Create a webhook-specific rate limiter with higher limits (since webhooks are asynchronous and less sensitive to latency):

**In `middleware/rateLimit.ts`:**
```typescript
const webhookLimiter = createLimiter(1000, 'webhook_'); // Higher limit for webhooks

export const webhookRateLimitMiddleware = (req: Request, res: Response, next: NextFunction) => {
  webhookLimiter(req, res, next);
};
```

**In `index.ts`:**
```typescript
app.use('/api/webhook', webhookRateLimitMiddleware);
app.use(ipRateLimitMiddleware);  // Applied to other routes only
```

**Tradeoff:** Still applies rate limiting but isolates the bucket from customer API traffic.

### Option 3: No Rate Limiting on Webhooks
Webhooks are already protected by HMAC signature verification, so skip IP rate limiting entirely:

**In `index.ts`:**
```typescript
// Apply IP rate limit BEFORE webhook routes (so webhooks bypass it)
app.use((req, res, next) => {
  if (!req.path.startsWith('/webhook/')) {
    ipRateLimitMiddleware(req, res, next);
  } else {
    next();
  }
});
```

**Tradeoff:** Webhooks have no DDoS protection at the IP level, but they're already HMAC-signed and can't be spoofed.

## Recommended Implementation

**Option 1** is recommended because it:
1. ✅ Isolates webhook and API traffic completely
2. ✅ Keeps webhook security intact (HMAC verification still applies)
3. ✅ Minimal code change
4. ✅ Doesn't require new middleware or routing reorganization
5. ✅ Clear intent in the code

## Testing

Add test to `rateLimit.test.ts`:
```typescript
it('skips IP rate limiting for webhook endpoints', () => {
  const req = {
    ...mockReq,
    ip: '192.168.1.1',
    path: '/webhook/moonpay',  // Webhook path
  } as Request;

  ipRateLimitMiddleware(req, mockRes as Response, mockNext);

  // Should call next() without rate limiting
  expect(mockNext).toHaveBeenCalled();
  expect(mockRes.status).not.toHaveBeenCalled();
});
```

## Files to Modify

1. **`api/src/middleware/rateLimit.ts`**
   - Add webhook exclusion to `ipRateLimitMiddleware`

2. **`api/src/__tests__/rateLimit.test.ts`**
   - Add test for webhook exemption

3. **Documentation**
   - Update rate limiting docs to explain webhook isolation

## Impact Assessment

- **Backward compatibility:** ✅ No breaking changes
- **Performance:** ✅ No negative impact (single path check)
- **Security:** ✅ Improved (removes cross-contamination)
- **Testing:** New test case required
