# OpenAPI Documentation Gap Analysis

## Summary

The OpenAPI specification documents only **12 endpoints across 7 tags**, while the actual API implements **30+ endpoints across 14 route modules**. This creates a significant documentation drift.

## Documented Endpoints (12)

### Health (1)
- `GET /health` — Server health check

### Quote (1)
- `GET /api/v2/quote` — Fee quote

### Fund (2)
- `POST /api/v2/fund` — Submit funding transaction
- `POST /api/v2/fund/prepare` — Prepare unsigned transaction

### Status (1)
- `GET /api/v2/status/{txHash}` — Poll transaction status

### Offramp (3)
- `POST /api/v2/offramp/moonpay` — MoonPay widget URL
- `GET /api/v2/offramp/moonpay/quote` — MoonPay buy quote
- `POST /api/v2/offramp/transak` — Transak widget URL

### CEX (1)
- `POST /api/v2/cex/route` — CEX withdrawal routing

### API Keys (3)
- `POST /api/v1/keys` — Create API key
- `GET /api/v1/keys` — List API keys
- `DELETE /api/v1/keys/{id}` — Revoke API key

## Undocumented Endpoints (20+)

### Admin Routes (`admin.ts`) — 11 endpoints
All require `admin:keys` scope

**Fee Management:**
- `GET /api/v1/admin/fees` — Get current fee config
- `POST /api/v1/admin/fees` — Update fee rate
- `POST /api/v1/admin/fees/withdraw` — Withdraw accumulated fees

**Statistics & Monitoring:**
- `GET /api/v1/admin/stats` — Transaction statistics
- `GET /api/v1/admin/health` — Detailed health including circuit breakers

**Audit Log:**
- `GET /api/v1/admin/audit` — Admin action audit log
- `GET /api/v1/admin/audit/integrity` — Integrity audit entries
- `GET /api/v1/admin/audit/integrity/checkpoints` — List checkpoints
- `POST /api/v1/admin/audit/integrity/checkpoints` — Create checkpoint
- `GET /api/v1/admin/audit/integrity/verify` — Verify audit log integrity
- `GET /api/v1/admin/audit/integrity/export` — Export audit log (JSON/NDJSON)

### Webhook Admin Routes (`webhookAdmin.ts`) — 3 endpoints
All require `admin:keys` scope

- `POST /api/v1/webhooks/register` — Register webhook callback
- `GET /api/v1/webhooks` — List registered webhooks (inferred)
- `DELETE /api/v1/webhooks/{id}` — Unregister webhook (inferred)

### Transaction Routes (`transactions.ts`) — 1+ endpoints
- `GET /api/v1/transactions` — Transaction history
- `POST /api/v1/transactions/invalidate-cache` — Invalidate cache (internal)

### Cache Metrics Routes (`cacheMetrics.ts`) — 1 endpoint
Requires `admin:keys` scope

- `GET /api/v1/cache/metrics` — Cache hit/miss statistics

### Telemetry Routes (`telemetry.ts`) — 1 endpoint
No auth required (public endpoint)

- `POST /api/telemetry` — Submit SDK telemetry

### Metrics Routes (`metrics.ts`) — 1 endpoint
Requires RBAC auth (internal Prometheus metrics)

- `GET /metrics` — Prometheus metrics (protected)

### Webhook Routes (`webhook.ts`) — 2 endpoints
Webhook handlers with HMAC verification (not API-key protected)

- `POST /api/webhook/moonpay` — MoonPay webhook handler
- `POST /api/webhook/transak` — Transak webhook handler

### Partially Documented (`apiKeys.ts`)
- `GET /api/v1/keys` — Documented
- `POST /api/v1/keys` — Documented
- `DELETE /api/v1/keys/{id}` — Documented
- `GET /api/v1/keys/{id}` — **Undocumented** (get single key)
- `PATCH /api/v1/keys/{id}` — **Undocumented** (update key)

## Test Coverage Issue

`openapi.test.ts` only validates that **documented endpoints exist**:

```typescript
it('openapi.json documents the quote endpoint', async () => {
  const res = await request(app).get('/api/openapi.json');
  const paths = res.body.paths as Record<string, unknown>;
  expect(paths['/api/v2/quote']).toBeDefined();  // ✓ Asserts documented endpoint is in spec
});
```

**What the tests DON'T check:**
- ❌ Whether undocumented routes are missing from spec
- ❌ Route completeness (no audit of all routes vs spec)
- ❌ Whether internal/admin routes should be documented
- ❌ API surface stability (new routes without spec updates go unnoticed)

## Recommendations

### Tier 1: Documentation (High Priority)
Document these routes explicitly:
1. **Admin endpoints** — Internal management, should be in spec or marked as "internal"
2. **Cache metrics** — Useful for monitoring, warrants public documentation
3. **Webhook management** — Part of public API surface

### Tier 2: Test Coverage (High Priority)
Add validation tests:
1. Extract all routes from route files automatically
2. Compare against OpenAPI spec
3. Fail if undocumented public routes are found
4. Flag routes without API key requirement (public endpoints)

### Tier 3: Cleanup (Medium Priority)
- Decide: are admin routes internal-only or public?
- If internal: mark clearly in code and exclude from spec
- If public: add to OpenAPI spec with proper descriptions
- Consolidate telemetry/metrics route files

### Tier 4: Automation (Low Priority)
- Generate spec from JSDoc annotations on route handlers
- Or auto-detect routes and fail build if spec is incomplete

## Files to Update

1. `/api/src/openapi/spec.ts` — Add missing routes
2. `/api/src/__tests__/openapi.test.ts` — Add completeness validation
3. Route files — Add clear documentation/markers for public vs. internal

## Impact

**Current State:**
- API capabilities: 30+ endpoints
- Documented: 12 endpoints
- **Documentation coverage: ~40%**

**Risk:**
- Clients discover undocumented endpoints and build dependencies on them
- No contract/breaking-change detection
- Security features (admin routes) may not be obvious to operators
- Internal tools discovered as "API" by accident
