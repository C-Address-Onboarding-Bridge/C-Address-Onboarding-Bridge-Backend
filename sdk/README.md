# SDK

## TypeScript compatibility

The SDK is published with strict TypeScript compatibility in mind. Consumers can enable `strict` in their tsconfig without additional work.

## Telemetry

The SDK can emit anonymous usage telemetry when enabled. Telemetry is opt-out and can be disabled by setting `SDK_TELEMETRY_ENABLED=false`.

The payload includes only non-PII metadata such as SDK version, Node.js version, platform, invoked method, response time, and error type. No API keys, addresses, or transaction data are collected.

## Browser usage

The SDK ships with an ESM build for bundlers and a UMD bundle for browser script tags. Browser usage requires a global `fetch` implementation in the target environment.
