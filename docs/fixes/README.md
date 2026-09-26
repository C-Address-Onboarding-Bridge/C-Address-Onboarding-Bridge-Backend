# Past Fix Write-ups and Analysis Notes

This directory preserves historical fix write-ups and gap analyses that were previously committed to the repository root.

## Contents

- [**CORS_METHODS_FIX.md**](./CORS_METHODS_FIX.md) — Analysis and resolution of CORS configuration to support `DELETE`, `PATCH`, and other REST methods required by admin consoles.
- [**WEBHOOK_RATE_LIMIT_FIX.md**](./WEBHOOK_RATE_LIMIT_FIX.md) — Problem analysis and isolation strategy for webhook rate limiting.
- [**WEBHOOK_RATE_LIMIT_FIX_IMPLEMENTATION.md**](./WEBHOOK_RATE_LIMIT_FIX_IMPLEMENTATION.md) — Implementation details of the webhook path exclusion from global IP rate limiting.
- [**WEBSOCKET_CACHE_FIX.md**](./WEBSOCKET_CACHE_FIX.md) — Details on integrating the shared Redis cache into WebSocket status polling to prevent connection stampedes.
- [**OPENAPI_DOCUMENTATION_GAP.md**](./OPENAPI_DOCUMENTATION_GAP.md) — Detailed route audit comparing implemented endpoints against the OpenAPI specification.
