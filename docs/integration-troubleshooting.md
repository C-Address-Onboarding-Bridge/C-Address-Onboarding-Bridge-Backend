# Integration Troubleshooting Guide

This guide gives integrators a repeatable way to diagnose C-Address Onboarding Bridge failures before opening a support request. It covers authentication, validation, network, transaction, and webhook failures, plus logging and self-check steps that SDK consumers can automate.

## Quick Triage Checklist

1. Confirm the environment: testnet versus production, API base URL, Soroban network passphrase, and bridge contract ID.
2. Capture the request correlation ID, provider reference ID, transaction hash, and timestamp in UTC.
3. Check whether the failure happens before quote creation, during bridge request creation, during transaction submission, or after a webhook callback.
4. Reproduce with the smallest possible amount and a known-good C-address on testnet when available.
5. Review the error category below and follow the targeted debugging steps before retrying in production.

## Common Error Categories

### Authentication

Typical symptoms:

- 401 Unauthorized or 403 Forbidden responses.
- Requests succeed locally but fail in a deployed environment.
- Provider callbacks are rejected before payload processing.

Likely causes:

- Missing, expired, or malformed API key.
- API key belongs to the wrong environment or organization.
- Key scope does not allow quote, bridge, webhook, or admin operations.
- Webhook endpoint is using the wrong signing secret.

Debugging steps:

- Verify that the Authorization header is present and uses the expected format.
- Confirm the key was issued for the same environment as the API base URL.
- Rotate the key if it may have been copied from logs, tickets, or a shared screen.
- For webhook failures, recompute the signature using the raw request body, not a parsed JSON object.

### Validation

Typical symptoms:

- 400 Bad Request responses.
- Address, amount, asset, or XDR fields are rejected.
- SDK-generated requests work, but hand-written requests fail.

Likely causes:

- Invalid C-address or G-address format.
- Amount is zero, negative, below provider minimums, above provider maximums, or has too many decimal places.
- Asset code, issuer, or network passphrase does not match the configured environment.
- XDR is malformed, from the wrong network, or has been modified after quote creation.

Debugging steps:

- Validate addresses and assets before submitting a bridge request.
- Compare the request network, contract ID, and provider route against the selected environment.
- Decode XDR locally or through the SDK diagnostics helper before submission.
- Remove optional fields and retry with a minimal valid request.

### Network and Availability

Typical symptoms:

- 408, 429, 502, 503, or 504 responses.
- Requests time out before a provider quote is returned.
- Retrying immediately produces inconsistent provider errors.

Likely causes:

- Client, API, provider, or Horizon/RPC rate limits.
- Temporary provider outage or routing instability.
- DNS, proxy, or TLS configuration differences between local and hosted environments.

Debugging steps:

- Retry with exponential backoff and jitter; do not retry tight loops.
- Record provider and bridge correlation IDs for every failed attempt.
- Check whether only one provider route is failing or all routes are unavailable.
- Confirm outbound network access from the deployed environment to the API and provider endpoints.

### Transaction Errors

Typical symptoms:

- Bridge creation succeeds, but the Soroban transaction fails.
- Transaction simulation succeeds while submission fails.
- Duplicate transaction or invalid signature errors appear after retries.

Likely causes:

- Source account has insufficient XLM for fees, reserve, or transfer amount.
- Sequence number changed between quote creation and submission.
- Transaction was submitted twice with the same hash or nonce.
- The signed XDR does not match the account or network expected by the bridge request.

Debugging steps:

- Check account balance, reserves, trustlines, and recent sequence number before signing.
- Rebuild and re-sign the transaction after a stale-sequence failure.
- Treat duplicate transaction responses as idempotency signals when the transaction hash already reached the ledger.
- Compare the transaction hash in logs, provider records, and chain explorer output.

### Webhooks

Typical symptoms:

- Provider status updates are not reflected in bridge state.
- Webhook requests return 400 or 401 responses.
- The same callback is processed multiple times.

Likely causes:

- Signature mismatch caused by using a parsed body or wrong secret.
- Timestamp is outside the replay window.
- Provider event ID was already processed.
- Callback URL points to the wrong environment.

Debugging steps:

- Verify signatures against the raw body bytes and the provider-specific header list.
- Store and compare provider event IDs to confirm idempotency behavior.
- Confirm that callback URLs use HTTPS and target the same environment that created the quote.
- Replay only provider-approved test events; do not replay live payment callbacks without coordination.

## Error Code Reference

| Code | Category | Meaning | First action |
| --- | --- | --- | --- |
| 400 | Validation | Request shape, address, amount, asset, or XDR is invalid | Validate fields locally and retry with a minimal request |
| 401 | Authentication | Missing or invalid credential | Check API key, webhook secret, and environment |
| 403 | Authentication | Credential is valid but lacks permission | Confirm key scope and organization access |
| 404 | Validation | Referenced quote, route, bridge request, or provider object was not found | Verify IDs and environment |
| 409 | Transaction | Duplicate request, stale sequence, or conflicting state transition | Check idempotency key and transaction hash |
| 422 | Validation | Request is syntactically valid but cannot be processed | Review provider limits, supported assets, and destination rules |
| 429 | Network | Rate limit exceeded | Back off with jitter and reduce concurrency |
| 500 | Network | Unexpected server error | Capture correlation ID and retry only if operation is idempotent |
| 502 | Network | Upstream provider or RPC failure | Check provider route and retry later |
| 503 | Network | Service unavailable | Retry later or switch provider route if supported |
| 504 | Network | Timeout | Confirm provider health and retry with backoff |

## Self-Diagnostic SDK Helpers

SDKs should expose or document helpers that integrators can run before submitting production requests:

- validateAddress(address): confirms C-address or G-address format and expected network.
- validateBridgeRequest(payload): checks required fields, amount precision, asset support, and environment consistency.
- decodeTransactionXdr(xdr): returns network, source, operations, fee, and expiration details without submitting the transaction.
- getRequestStatus(id): retrieves quote or bridge request state by ID.
- buildSupportBundle(id): collects non-secret diagnostics such as correlation ID, route, provider reference, transaction hash, status, and timestamps.

Do not include API keys, webhook secrets, private keys, seed phrases, bearer tokens, or full payment-provider personal data in diagnostics output.

## Enabling Debug Logs

For local development, enable structured debug output around request construction, provider routing, transaction submission, and webhook verification. Logs should include correlation IDs and state transitions while masking credentials and personal data.

Recommended fields:

- environment, network passphrase, and bridge contract alias.
- request ID, quote ID, bridge request ID, provider event ID, and transaction hash.
- route/provider name and high-level status.
- elapsed time, retry count, and final error category.

Fields to mask or omit:

- API keys, bearer tokens, webhook secrets, private keys, and seed phrases.
- Raw provider payment data that is not needed to diagnose the bridge state.
- Full personal data values; use stable redacted suffixes when correlation is necessary.

## Reading Logs

Start from the first correlation ID emitted by the SDK or API. Follow it through quote creation, route selection, transaction preparation, transaction submission, webhook receipt, and final state update. A missing transition usually identifies the layer that failed.

Examples:

- Quote exists but no bridge request: inspect validation and provider limit errors.
- Bridge request exists but no transaction hash: inspect signing, account balance, sequence, and XDR validation.
- Transaction hash exists but status is pending: inspect chain confirmation and webhook delivery.
- Webhook received but state unchanged: inspect signature verification, replay protection, and idempotency handling.

## Contacting Support

When self-diagnosis does not resolve the issue, provide:

- Environment and network.
- UTC timestamp range.
- Correlation ID, quote ID, bridge request ID, provider reference ID, and transaction hash when available.
- Redacted request payload and response body.
- SDK version, runtime, browser or server platform, and wallet/provider used.
- Steps already attempted from this guide.

Never send private keys, seed phrases, API keys, webhook secrets, or complete payment credentials in a support request.
