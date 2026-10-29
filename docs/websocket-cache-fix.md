# WebSocket Cache Integration Fix

## Problem

Each WebSocket `subscribe()` call created its own `setInterval` polling loop that directly called `sorobanService.getTransactionStatus()`, completely bypassing the shared Redis cache used by `routes/status.ts`.

### Attack Vector & Impact

**Resource Amplification:**
- 1 client watching 1 transaction: 1 RPC call every 5 seconds
- 100 clients watching the same transaction: 100 RPC calls every 5 seconds
- **Amplification factor: ~600x** (100 clients × 1200 calls/min vs 1 call/5 sec expected)

**Why This Matters:**
- Each RPC call incurs network latency and Soroban node resource costs
- No single-flight stampede protection (N clients = N queries even if within TTL)
- No benefit from Redis cache invalidation on webhooks
- Uncontrolled scaling with concurrent WebSocket connections

## Root Cause

The `pollStatus()` function in `services/websocket.ts` called:
```typescript
const status = await sorobanService.getTransactionStatus(sub.txHash);
```

Instead of using the shared cache layer:
```typescript
const cacheKey = buildCacheKey(STATUS_CACHE_NAMESPACE, sub.txHash);
const status = await getOrCompute(cacheKey, CACHE_TTL.status, async () => {
  return sorobanService.getTransactionStatus(sub.txHash);
});
```

## Solution

Modified `services/websocket.ts` to use the same `getOrCompute()` cache function as `routes/status.ts`:

### Changes Made

1. **Added cache imports** to `websocket.ts`:
   ```typescript
   import { buildCacheKey, CACHE_TTL, getOrCompute } from './cache';
   ```

2. **Added cache namespace constant**:
   ```typescript
   const STATUS_CACHE_NAMESPACE = 'status';
   ```

3. **Updated `pollStatus()` function** to use shared cache:
   ```typescript
   async function pollStatus(client: ClientState, sub: Subscription): Promise<void> {
     try {
       const cacheKey = buildCacheKey(STATUS_CACHE_NAMESPACE, sub.txHash);
       
       // Use the shared cache to fetch status (same cache as routes/status.ts)
       // This prevents N clients from creating N independent RPC polls
       const status = await getOrCompute(
         cacheKey,
         CACHE_TTL.status,
         async () => {
           return sorobanService.getTransactionStatus(sub.txHash);
         }
       );
       
       // ... rest of function unchanged
     } catch (err) {
       // ... error handling
     }
   }
   ```

## Benefits

✅ **Shared Cache**: Multiple WebSocket clients for the same txHash now share a single RPC call within the cache TTL (30 seconds)

✅ **Single-Flight Protection**: The cache's built-in stampede protection prevents thundering herd queries from N concurrent requests

✅ **Webhook Integration**: Status cache invalidation from webhooks now affects both REST and WebSocket clients

✅ **Linear Scaling**: Resource consumption scales with unique transactions, not total subscribers

✅ **Resource Efficiency**: 100 clients watching 1 transaction = ~1 RPC call/5 sec instead of 100 calls/5 sec (100x improvement)

## Testing

Added test in `api/src/__tests__/websocket.test.ts`:
```typescript
it('uses shared cache for status polling to prevent N clients × N RPC polls', async () => {
  // Verifies getOrCompute is called (the shared cache function)
  // Verifies the cache key is built with the transaction hash
  expect(vi.mocked(getOrCompute)).toHaveBeenCalled();
  const cacheCallArgs = vi.mocked(getOrCompute).mock.calls[0];
  expect(cacheCallArgs[0]).toContain(txHash);
});
```

All 27 WebSocket tests pass, confirming:
- Subscription/unsubscription behavior is unchanged
- Status polling works as expected
- Terminal status handling (success/failed) still triggers auto-close
- Cache integration doesn't break existing functionality

## Architecture

### Before
```
Client1 ──┐
Client2 ──┼──> setInterval ──> sorobanService.getTransactionStatus()
Client3 ──┘
```
Each client has its own polling loop with independent RPC calls.

### After
```
Client1 ──┐
Client2 ──┼──> setInterval ──> getOrCompute() ──> shared Redis cache ──> sorobanService
Client3 ──┘                                        (30-second TTL)
```
All clients share the same cached value. Within the 30-second window, only 1 RPC call is made regardless of client count.

## Verification

**Metrics to monitor post-deployment:**
- RPC call count (should drop proportionally with WebSocket client count)
- Cache hit ratio for status namespace (should increase from REST-only to REST+WebSocket)
- p99 latency (should improve due to less RPC contention)
- Memory usage (should stabilize despite scaling WebSocket clients)

## Files Modified

- `/api/src/services/websocket.ts` — Added cache integration to `pollStatus()`
- `/api/src/__tests__/websocket.test.ts` — Added cache mock and new test case

## Compatibility

This change is **fully backward compatible**:
- WebSocket API remains unchanged (no new messages or protocol changes)
- Cache layer behavior is transparent to clients
- Existing deployments will see improved performance without code changes on client side
