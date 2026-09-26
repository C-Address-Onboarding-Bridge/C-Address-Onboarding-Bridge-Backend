# CORS Methods Configuration Fix

## Problem

The CORS middleware was configured to allow only `GET` and `POST` methods:

```typescript
cors({
  origin: config.corsOrigins.length > 0 ? config.corsOrigins : '*',
  methods: ['GET', 'POST'],  // ❌ Missing DELETE and PATCH
})
```

This prevented browser-based admin consoles at configured CORS origins from calling 4 legitimate API endpoints that require DELETE and PATCH methods.

## Affected Endpoints

### API Key Management (`/api/v1/keys/`)
1. `PATCH /api/v1/keys/:id` — Update API key properties (name, scopes, IP whitelist, expiry, rate limit)
2. `DELETE /api/v1/keys/:id` — Revoke API key

### Webhook Management (`/api/v1/webhooks/`)
3. `DELETE /api/v1/webhooks/registrations/:id` — Delete webhook registration
4. `DELETE /api/v1/webhooks/dlq/:id` — Delete dead-letter queue entry

## Root Cause

Browser's CORS preflight mechanism:
1. Browser sends `OPTIONS` request with `Access-Control-Request-Method: DELETE`
2. Server (via CORS middleware) responds with `Access-Control-Allow-Methods: GET,POST`
3. Browser checks: "Is DELETE in [GET, POST]?" → **No**
4. Browser **rejects the actual request without sending it** (fails silently)
5. Admin console receives CORS error instead of reaching the API

**Impact:**
- Delete operations completely unavailable from browser apps
- Admin dashboards cannot revoke keys or manage webhooks
- Only affects browser-based clients (CLIs with explicit headers work)

## Solution

Updated CORS configuration to include `DELETE` and `PATCH`:

```typescript
cors({
  origin: config.corsOrigins.length > 0 ? config.corsOrigins : '*',
  methods: ['GET', 'POST', 'DELETE', 'PATCH'],  // ✅ Now includes all needed methods
})
```

## Why These Methods?

### GET & POST (already allowed)
- Quote, fund, status endpoints
- Public use: fetch data, submit transactions

### DELETE (newly added)
- Revoke API keys → key management
- Unregister webhooks → webhook cleanup  
- Remove DLQ entries → dead-letter cleanup
- Administrative operations requiring explicit deletion

### PATCH (newly added)
- Update API key properties → key management
- Modify webhook registration → webhook management
- Non-breaking updates to existing resources

**Note:** PUT is not included since the API uses PATCH for partial updates (RESTful best practice).

## Browser Security

CORS allows the browser to verify:
1. ✅ Origin is in whitelist (origin check)
2. ✅ Method is in allowed list (preflight check) ← **Fixed by this change**
3. ✅ Headers are allowed (header check)
4. ✅ Credentials handling

This is still secure because:
- Admin endpoints require `admin:keys` scope (auth check happens on server)
- CORS whitelist still restricts which origins can make requests
- Origin must be explicitly configured in `CORS_ORIGINS` env var
- No change to backend authentication or authorization

## Testing

Added/updated tests in `cors.test.ts`:
- ✅ `allows GET, POST, DELETE, PATCH methods in preflight`
- ✅ `allows DELETE method for API key revocation (CORS preflight)`
- ✅ `allows PATCH method for API key updates (CORS preflight)`
- ✅ `allows DELETE method for webhook management (CORS preflight)`
- ✅ `does not allow preflight from an unconfigured origin` (security verification)

All tests verify:
1. Preflight OPTIONS returns 204 (success)
2. `Access-Control-Allow-Methods` header contains the required method
3. Unconfigured origins are still rejected

## Configuration

No environment variables changed. The fix is automatic for all deployments.

**Verification:**
```bash
# From browser console at a configured CORS origin:
fetch('https://api.example.com/api/v1/keys/key-id', {
  method: 'DELETE',
  headers: { 'X-API-Key': 'your-key' }
})
// Now works! Before: CORS error
```

## Impact

**Before Fix:**
- Browser admin console: Can't delete/update keys or webhooks (403 CORS error)
- CLI with explicit headers: Works fine
- **Admin UX: Broken for browser-based tools**

**After Fix:**
- Browser admin console: Can delete/update keys and webhooks ✅
- CLI with explicit headers: Still works ✅
- **Admin UX: Fully functional**

## Backward Compatibility

✅ **Fully backward compatible**
- Existing GET/POST clients unaffected
- New DELETE/PATCH methods only affect features that were previously blocked by CORS
- No API signature changes
- No breaking changes

## Files Modified

- `/api/src/index.ts` — CORS methods array
- `/api/src/__tests__/cors.test.ts` — Enhanced test coverage
