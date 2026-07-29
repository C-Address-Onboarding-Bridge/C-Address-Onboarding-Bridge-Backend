# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

---

## [0.1.0] — 2026-07-29

### Added
- Soroban onboarding-bridge smart contract with fee-based fund routing
- Express API with versioned REST endpoints (`/api/v1`)
- RBAC-backed authentication and per-scope authorization
- WebSocket server with auth-gated subscription support
- Redis-backed caching with per-resource TTLs and in-process fallback
- BullMQ background-jobs subsystem (tx-status polling, webhook retry, cache warmup, metrics, cleanup, async audit)
- Async processing pipeline with backpressure threshold
- Idempotency key enforcement on `POST /api/v1/fund`
- Webhook delivery with HMAC-SHA256 signing and retry logic
- MoonPay and Transak offramp integrations with webhook verification
- CEX withdrawal routing (Binance, Coinbase, Kraken) with signed requests
- RPC pool with round-robin / latency / random selection strategy and circuit breaker
- OpenTelemetry tracing and Loki log shipping
- Response compression with configurable threshold
- Graceful shutdown with configurable timeout
- Multi-migration database schema with query-optimisation indexes
- k6 load-test script with ramp-up/steady/ramp-down stages and p95 < 500 ms threshold
- Rate limiting with optional Redis store and per-key burst factor
- Correlation-ID middleware for distributed tracing
- Audit log with integrity verification
- Fuzz targets for admin ops, fee calculation, and fund sequence (Rust)
- CI pipelines: tests, security scanning, container security, benchmarks, fuzz, deploy, rollback

### Fixed
- RBAC double-auth removed; fee-basis-point validation bounds enforced
- CEX secrets registered correctly; Soroban XDR validator wired
- Versioning middleware deduplicated; CIDR /0 mask corrected; IPv6 CIDR support added
- Webhook log headers masked; request-body redaction filter applied consistently
- Dead middleware and configuration code removed

[Unreleased]: https://github.com/C-Address-Onboarding-Bridge/C-Address-Onboarding-Bridge-Backend/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/C-Address-Onboarding-Bridge/C-Address-Onboarding-Bridge-Backend/releases/tag/v0.1.0
