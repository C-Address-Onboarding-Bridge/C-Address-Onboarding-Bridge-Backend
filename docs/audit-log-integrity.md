# Audit Log Integrity

The bridge maintains a hash-chained integrity audit log for financial and administrative events. Each entry includes the prior entry hash, so deleting, reordering, or editing an entry breaks verification.

## Events Logged

- `transaction_submission`: funding intent from `/fund/prepare`, including amount, fee basis points, source, destination, token address, and memo hash.
- `transaction_submission_result`: signed transaction submission result, transaction hash, status, signed XDR hash, and error if present.
- `fee_withdrawal`: withdrawn amount, recipient/admin actor, and status.
- `admin_operation`: administrative changes such as fee changes. Future pause/upgrade routes should use this same event type.
- `webhook_delivery`: payload hash, destination URL, registration ID, event, attempt number, status/result, and error if present.

Payloads avoid raw secrets. Webhook payloads and memos are recorded as SHA-256 hashes rather than raw values.

## Hash Chain

For each entry:

1. Canonicalize the entry fields with stable key ordering.
2. Include `sequence`, `id`, `timestamp`, `type`, `actor`, `payload`, `previousHash`, and `retentionUntil`.
3. Compute `hash = sha256(canonical_entry_without_hash)`.
4. Store the previous entry hash in `previousHash`; the first entry uses 64 zeroes.

Verification recomputes every hash, checks sequence continuity, checks `previousHash`, and compares checkpoints against recomputed hashes.

## Checkpoints

Checkpoints record `{ sequence, hash, timestamp, publisher, publicationRef }`.

- Automatic checkpointing occurs every `AUDIT_CHECKPOINT_INTERVAL` entries. Default: `10`.
- If `AUDIT_CHECKPOINT_URL` is set, the service posts checkpoints to that trusted timestamp/on-chain relay endpoint.
- If no URL is configured or publication fails, a local checkpoint is recorded for offline verification.
- Admins can force a checkpoint with `POST /api/v1/admin/audit/integrity/checkpoints`.

## Admin API

All endpoints require `admin:keys`.

```text
GET  /api/v1/admin/audit/integrity?type=&limit=&cursor=
GET  /api/v1/admin/audit/integrity/checkpoints
POST /api/v1/admin/audit/integrity/checkpoints
GET  /api/v1/admin/audit/integrity/verify
GET  /api/v1/admin/audit/integrity/export
GET  /api/v1/admin/audit/integrity/export?format=ndjson
```

The JSON export uses format marker `c-address-bridge.audit.v1`. NDJSON is available for auditor ingestion pipelines.

## Persistent Schema

Migration `004_integrity_audit_log` defines:

- `audit_log_entries`: append-only audit events with sequence, event type, actor, payload, previous hash, current hash, creation timestamp, and 7-year retention timestamp.
- `audit_log_checkpoints`: published checkpoints tied to audit entry sequence and hash.

The current runtime service is in-memory until persistence is wired, matching the rest of the current database layer. When persistence is connected, writes should be append-only and updates/deletes should be blocked except for retention expiry jobs after the 7-year retention period.

## Tamper Detection Procedure

1. Export entries and checkpoints from the admin API.
2. Recompute entry hashes in sequence using stable canonicalization.
3. Confirm each `previousHash` equals the prior entry hash.
4. Confirm every checkpoint hash equals the recomputed hash for its sequence.
5. Treat any mismatch as a potential audit-trail integrity incident.

The built-in verification endpoint performs these checks and returns HTTP `409` when tampering is detected.

## Retention

Audit entries are retained for 7 years. The service stamps every entry with `retentionUntil = timestamp + 7 years`. Cleanup jobs must not delete entries before this timestamp, and checkpoint records should be retained at least as long as the entries they verify.
