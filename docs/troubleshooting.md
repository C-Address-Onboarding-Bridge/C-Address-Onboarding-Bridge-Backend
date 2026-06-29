# Integration Troubleshooting Guide

> A comprehensive guide for diagnosing and resolving common integration issues with the C-Address Onboarding Bridge.

---

## Table of Contents

1. [Quick Diagnostic Tool](#quick-diagnostic-tool)
2. [Common Error Categories](#common-error-categories)
   - [Authentication Errors](#authentication-errors)
   - [Validation Errors](#validation-errors)
   - [Network Errors](#network-errors)
   - [Transaction Errors](#transaction-errors)
   - [Webhook Errors](#webhook-errors)
3. [Error Code Reference](#error-code-reference)
4. [Debugging Steps](#debugging-steps)
5. [Enabling Debug Logging](#enabling-debug-logging)
6. [Log Interpretation Guide](#log-interpretation-guide)
7. [Contacting Support](#contacting-support)

---

## Quick Diagnostic Tool

The SDK provides a self-service diagnostic tool to quickly identify common issues:

```typescript
import { BridgeClient } from "@c-address-bridge/sdk";

const client = new BridgeClient({
  baseUrl: "https://api.bridge.example.com",
  apiKey: "your-api-key",
});

// Run diagnostics
const diagnostics = await client.runDiagnostics({
  checkApiKey: true,
  checkConnectivity: true,
  checkContractStatus: true,
  targetAddress: "C...", // Optional: test specific address
});

console.log(diagnostics);
/* Example output:
{
  status: 'healthy',
  checks: {
    apiKey: { status: 'pass', message: 'API key is valid' },
    connectivity: { status: 'pass', latency: 45 },
    contractStatus: { status: 'pass', version: '1.0.0' },
    addressValidation: { status: 'pass', addressType: 'C-address' }
  },
  timestamp: '2024-01-15T10:30:00Z'
}
*/
```

---

## Common Error Categories

### Authentication Errors

#### Error: `INVALID_API_KEY`

**Symptom**: `401 Unauthorized - Invalid API key`

**Causes**:

- API key is incorrect or mistyped
- API key has been revoked or expired
- API key not included in request headers

**Resolution**:

```typescript
// ✅ Correct way to set API key
const client = new BridgeClient({
  baseUrl: "https://api.bridge.example.com",
  apiKey: process.env.BRIDGE_API_KEY, // Use environment variable
});

// ❌ Common mistakes
// - Hardcoding API key in source code
// - Using API key from wrong environment (dev key in production)
// - Missing 'Bearer ' prefix in custom implementations
```

**Verification Steps**:

1. Check API key in your dashboard: `https://dashboard.bridge.example.com/api-keys`
2. Verify the key hasn't expired
3. Test with a fresh API key
4. Ensure key has correct scopes for the operation

---

#### Error: `EXPIRED_API_KEY`

**Symptom**: `401 Unauthorized - API key has expired`

**Causes**:

- API key has passed its expiration date
- Key was configured with a time limit

**Resolution**:

1. Generate a new API key from the dashboard
2. Update your application configuration
3. Consider using keys without expiration for production
4. Set up monitoring to alert before key expiration

---

#### Error: `INSUFFICIENT_SCOPE`

**Symptom**: `403 Forbidden - Insufficient permissions for this operation`

**Causes**:

- API key doesn't have required scopes
- Trying to access admin endpoints with user-level key

**Resolution**:

```typescript
// Check required scopes for operations:
// - quote.read: GET /api/v1/quote
// - fund.write: POST /api/v1/fund
// - status.read: GET /api/v1/status/:txHash
// - admin.*: Admin endpoints (POST /api/v1/admin/*)

// Generate a new key with correct scopes in dashboard
```

---

### Validation Errors

#### Error: `INVALID_ADDRESS`

**Symptom**: `400 Bad Request - Invalid Stellar address format`

**Causes**:

- Address doesn't match G-address or C-address format
- Typo in address
- Wrong address type for operation

**Resolution**:

```typescript
import { utils } from "@c-address-bridge/sdk";

// Validate addresses before sending
const address = "C...";

if (!utils.isValidStellarAddress(address)) {
  console.error("Invalid Stellar address format");
}

if (!utils.isCAddress(address)) {
  console.error("Address must be a C-address (Contract address)");
}

// Common mistakes:
// - Using G-address where C-address is required
// - Including whitespace or special characters
// - Using testnet address on mainnet (or vice versa)
```

---

#### Error: `INVALID_AMOUNT`

**Symptom**: `400 Bad Request - Amount must be a positive integer in stroops`

**Causes**:

- Amount is negative or zero
- Amount is not in stroops (smallest unit)
- Amount exceeds maximum i128 value
- Amount is a decimal number

**Resolution**:

```typescript
// ✅ Correct format (stroops are integer units)
const amount = "10000000"; // 1 XLM = 10,000,000 stroops

// ❌ Common mistakes
const wrongAmount1 = 1.5; // Should be string, not number
const wrongAmount2 = "1.5"; // Should be integer (stroops)
const wrongAmount3 = "-10000000"; // Cannot be negative
const wrongAmount4 = "0"; // Must be positive

// Conversion helper
function xlmToStroops(xlm: number): string {
  return (xlm * 10_000_000).toString();
}

const validAmount = xlmToStroops(1.5); // '15000000'
```

---

#### Error: `MALFORMED_XDR`

**Symptom**: `400 Bad Request - Transaction XDR is malformed or invalid`

**Causes**:

- XDR string is corrupted or incomplete
- Base64 encoding issues
- XDR from different network (testnet vs mainnet)

**Resolution**:

```typescript
// Ensure XDR is properly encoded
try {
  // If building transaction manually, use stellar-sdk
  import { TransactionBuilder } from "@stellar/stellar-sdk";

  const transaction = TransactionBuilder.buildTransaction(/* ... */);
  const xdr = transaction.toXDR(); // Automatically base64 encoded

  // Verify XDR is valid before sending
  const parsed = TransactionBuilder.fromXDR(xdr, networkPassphrase);
  console.log("XDR is valid");
} catch (error) {
  console.error("Invalid XDR:", error.message);
}
```

---

### Network Errors

#### Error: `CONNECTION_TIMEOUT`

**Symptom**: Request fails with timeout error after 30 seconds

**Causes**:

- Network connectivity issues
- API server is down or overloaded
- Firewall blocking requests
- DNS resolution failure

**Resolution**:

1. Check internet connectivity
2. Verify API endpoint URL: `https://api.bridge.example.com/health`
3. Check status page: `https://status.bridge.example.com`
4. Try with increased timeout:

```typescript
const client = new BridgeClient({
  baseUrl: "https://api.bridge.example.com",
  apiKey: "your-api-key",
  timeout: 60000, // 60 seconds
});
```

---

#### Error: `RATE_LIMIT_EXCEEDED`

**Symptom**: `429 Too Many Requests - Rate limit exceeded`

**Causes**:

- Too many requests in short time period
- Exceeded per-minute or per-hour quota
- Multiple clients using same API key

**Resolution**:

```typescript
// Implement exponential backoff retry logic
async function callWithRetry(fn, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (error.status === 429) {
        const retryAfter = error.headers?.["retry-after"] || 2 ** i * 1000;
        console.log(`Rate limited. Retrying after ${retryAfter}ms`);
        await new Promise((resolve) => setTimeout(resolve, retryAfter));
      } else {
        throw error;
      }
    }
  }
  throw new Error("Max retries exceeded");
}

// Use it
const quote = await callWithRetry(() =>
  client.getQuote({
    /* ... */
  }),
);
```

**Rate Limits** (default):

- Standard tier: 100 requests/minute, 5,000 requests/hour
- Premium tier: 1,000 requests/minute, 50,000 requests/hour

---

#### Error: `SERVICE_UNAVAILABLE`

**Symptom**: `503 Service Unavailable - Service temporarily unavailable`

**Causes**:

- Scheduled maintenance
- Soroban RPC node unavailable
- Database connection issues
- Circuit breaker triggered due to upstream failures

**Resolution**:

1. Check status page for maintenance windows
2. Retry request after a short delay (5-10 seconds)
3. Implement health checks before critical operations:

```typescript
const health = await fetch("https://api.bridge.example.com/health");
if (health.ok) {
  // Proceed with operation
} else {
  // Use fallback or queue for retry
}
```

---

### Transaction Errors

#### Error: `INSUFFICIENT_FUNDS`

**Symptom**: Transaction fails with insufficient balance

**Causes**:

- Source account doesn't have enough balance
- Not accounting for network fees
- Amount + fees exceed available balance

**Resolution**:

```typescript
// Always check balance before funding
const quote = await client.getQuote({
  sourceAsset: "XLM",
  amount: "10000000",
  targetAddress: "C...",
});

console.log(`Amount: ${quote.amount} stroops`);
console.log(`Fee: ${quote.estimatedFee} stroops`);
console.log(
  `Total needed: ${BigInt(quote.amount) + BigInt(quote.estimatedFee)} stroops`,
);

// Ensure source account has sufficient balance
// Balance must be > (amount + fee + network fee + minimum reserve)
```

---

#### Error: `DUPLICATE_TRANSACTION`

**Symptom**: `409 Conflict - Transaction with this hash already processed`

**Causes**:

- Same transaction submitted multiple times
- Idempotency key reused for different transaction
- Client-side retry without checking status

**Resolution**:

```typescript
// Use idempotency keys for safe retries
const result = await client.fundAddress({
  sourceAddress: "G...",
  targetAddress: "C...",
  amount: "10000000",
  idempotencyKey: "unique-operation-id-123", // Generate unique key per operation
});

// Safe to retry with same key - will return original result
```

---

#### Error: `INVALID_SIGNATURE`

**Symptom**: Transaction rejected due to invalid signature

**Causes**:

- Wrong secret key used for signing
- Transaction modified after signing
- Signature expired (time bounds exceeded)

**Resolution**:

```typescript
// Ensure you're using the correct secret key for the source address
import { Keypair } from "@stellar/stellar-sdk";

const keypair = Keypair.fromSecret("SXXXXX...");
console.log("Public key:", keypair.publicKey()); // Verify this matches sourceAddress

// Check transaction hasn't been modified after signing
// Verify time bounds are still valid
```

---

### Webhook Errors

#### Error: `WEBHOOK_SIGNATURE_MISMATCH`

**Symptom**: Webhook rejected with `401 Unauthorized - Invalid signature`

**Causes**:

- Webhook secret doesn't match
- Request body was modified before verification
- Timestamp too old (replay attack protection)

**Resolution**:

```typescript
import crypto from "crypto";

// Verify webhook signature (example for Express)
function verifyWebhookSignature(req, webhookSecret) {
  const signature = req.headers["x-bridge-signature"];
  const timestamp = req.headers["x-bridge-timestamp"];
  const body = JSON.stringify(req.body);

  // Check timestamp is recent (within 5 minutes)
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp)) > 300) {
    throw new Error("Timestamp too old");
  }

  // Verify signature
  const payload = `${timestamp}.${body}`;
  const expectedSignature = crypto
    .createHmac("sha256", webhookSecret)
    .update(payload)
    .digest("hex");

  if (signature !== expectedSignature) {
    throw new Error("Invalid signature");
  }

  return true;
}
```

---

#### Error: `WEBHOOK_REPLAY_DETECTED`

**Symptom**: `400 Bad Request - Webhook replay detected`

**Causes**:

- Same webhook payload sent multiple times
- Timestamp reused from old request

**Resolution**:

- Implement idempotency using webhook event IDs
- Store processed event IDs to prevent duplicates

```typescript
const processedEvents = new Set(); // Use Redis in production

app.post("/webhooks/bridge", (req, res) => {
  const eventId = req.headers["x-bridge-event-id"];

  if (processedEvents.has(eventId)) {
    // Already processed, return success
    return res.status(200).send("OK");
  }

  // Process webhook
  // ...

  processedEvents.add(eventId);
  res.status(200).send("OK");
});
```

---

#### Error: `WEBHOOK_PAYLOAD_EXPIRED`

**Symptom**: Webhook rejected due to old timestamp

**Causes**:

- Webhook delivery delayed (network issues)
- Server clock out of sync

**Resolution**:

1. Ensure server time is synchronized (use NTP)
2. Allow reasonable time window (5 minutes default)
3. Contact support if webhooks consistently arrive late

---

## Error Code Reference

| Code      | HTTP Status | Category       | Description            | Action                                  |
| --------- | ----------- | -------------- | ---------------------- | --------------------------------------- |
| `AUTH001` | 401         | Authentication | Invalid API key        | Check API key is correct                |
| `AUTH002` | 401         | Authentication | Expired API key        | Generate new API key                    |
| `AUTH003` | 403         | Authentication | Insufficient scope     | Request key with required scopes        |
| `VAL001`  | 400         | Validation     | Invalid address format | Verify address format (G/C-address)     |
| `VAL002`  | 400         | Validation     | Invalid amount         | Use positive integer in stroops         |
| `VAL003`  | 400         | Validation     | Malformed XDR          | Check XDR encoding and network          |
| `VAL004`  | 400         | Validation     | Invalid token address  | Verify token contract address           |
| `NET001`  | 408         | Network        | Request timeout        | Retry with exponential backoff          |
| `NET002`  | 429         | Network        | Rate limit exceeded    | Implement retry with backoff            |
| `NET003`  | 503         | Network        | Service unavailable    | Check status page, retry later          |
| `TX001`   | 400         | Transaction    | Insufficient funds     | Ensure sufficient balance + fees        |
| `TX002`   | 409         | Transaction    | Duplicate transaction  | Check status or use new idempotency key |
| `TX003`   | 400         | Transaction    | Invalid signature      | Verify secret key matches source        |
| `TX004`   | 400         | Transaction    | Transaction expired    | Check time bounds, resubmit             |
| `HOOK001` | 401         | Webhook        | Invalid signature      | Verify webhook secret                   |
| `HOOK002` | 400         | Webhook        | Replay detected        | Implement idempotency checks            |
| `HOOK003` | 400         | Webhook        | Payload expired        | Check timestamp and server time         |

---

## Debugging Steps

### Step-by-Step Debugging Process

#### 1. Reproduce the Error

- Document exact steps to trigger the error
- Note any error messages, codes, and HTTP status
- Collect relevant request/response data

#### 2. Check API Key and Authentication

```bash
# Test API key with curl
curl -H "Authorization: Bearer YOUR_API_KEY" \
  https://api.bridge.example.com/health

# Expected: 200 OK with health status
```

#### 3. Validate Input Data

```typescript
// Use SDK utilities to validate before sending
import { utils } from "@c-address-bridge/sdk";

console.log("Address valid:", utils.isValidStellarAddress(address));
console.log("Is C-address:", utils.isCAddress(address));
console.log("Amount:", amount, "stroops");
```

#### 4. Check Network Connectivity

```bash
# Test connectivity
curl https://api.bridge.example.com/health

# Check DNS resolution
nslookup api.bridge.example.com

# Test with verbose output
curl -v https://api.bridge.example.com/api/v1/quote?sourceAsset=XLM&amount=10000000&targetAddress=C...
```

#### 5. Review Logs

- Enable debug logging (see next section)
- Check both client and server logs
- Look for correlation IDs to trace requests

#### 6. Test in Isolation

- Create minimal reproduction case
- Test with SDK diagnostic tool
- Try with different API keys/environments

---

## Enabling Debug Logging

### SDK Debug Mode

```typescript
// Enable verbose logging
const client = new BridgeClient({
  baseUrl: "https://api.bridge.example.com",
  apiKey: "your-api-key",
  debug: true, // Enables detailed logging
  logger: console, // Custom logger (optional)
});

// All requests and responses will be logged
const quote = await client.getQuote({
  /* ... */
});
```

### Custom Logger

```typescript
import { BridgeClient } from "@c-address-bridge/sdk";
import winston from "winston";

const logger = winston.createLogger({
  level: "debug",
  format: winston.format.json(),
  transports: [
    new winston.transports.File({ filename: "bridge-debug.log" }),
    new winston.transports.Console(),
  ],
});

const client = new BridgeClient({
  baseUrl: "https://api.bridge.example.com",
  apiKey: process.env.BRIDGE_API_KEY,
  debug: true,
  logger: {
    debug: (msg, meta) => logger.debug(msg, meta),
    info: (msg, meta) => logger.info(msg, meta),
    warn: (msg, meta) => logger.warn(msg, meta),
    error: (msg, meta) => logger.error(msg, meta),
  },
});
```

### Server-Side Logging

Set environment variable to enable debug logs:

```bash
# Enable debug logs for API server
export LOG_LEVEL=debug
npm start -w api
```

---

## Log Interpretation Guide

### Understanding Log Entries

#### Successful Request Log

```json
{
  "level": "info",
  "timestamp": "2024-01-15T10:30:00.123Z",
  "correlationId": "req-abc123",
  "method": "POST",
  "path": "/api/v1/fund",
  "statusCode": 200,
  "duration": 1234,
  "message": "Request completed"
}
```

**What to look for**:

- `correlationId`: Unique ID to trace request across logs
- `duration`: Response time in milliseconds
- `statusCode`: HTTP response code

---

#### Failed Request Log

```json
{
  "level": "error",
  "timestamp": "2024-01-15T10:30:05.456Z",
  "correlationId": "req-xyz789",
  "method": "POST",
  "path": "/api/v1/fund",
  "statusCode": 400,
  "error": {
    "code": "VAL001",
    "message": "Invalid address format",
    "details": {
      "field": "targetAddress",
      "value": "INVALID..."
    }
  },
  "message": "Request failed"
}
```

**What to look for**:

- `error.code`: Reference error code table above
- `error.details`: Specific field or value causing error
- `correlationId`: Use to find related logs

---

#### Transaction Log

```json
{
  "level": "info",
  "timestamp": "2024-01-15T10:30:10.789Z",
  "correlationId": "req-xyz789",
  "transactionHash": "a1b2c3d4...",
  "sourceAddress": "G...",
  "targetAddress": "C...",
  "amount": "10000000",
  "fee": "300",
  "status": "success",
  "message": "Transaction submitted to Soroban"
}
```

**What to look for**:

- `transactionHash`: Use to check status on Stellar explorer
- `status`: Transaction result (success, pending, failed)
- `fee`: Actual fee charged

---

### Common Log Patterns

#### Pattern: Rate Limiting

```
ERROR: Rate limit exceeded (429) - Retry after 60 seconds
INFO: Request queued for retry - Attempt 1 of 3
INFO: Retry successful after 62 seconds
```

**Action**: Implement exponential backoff, reduce request frequency

---

#### Pattern: Soroban RPC Timeout

```
ERROR: Soroban RPC timeout after 30000ms
INFO: Retrying with backup RPC node
INFO: Request successful on backup node
```

**Action**: No action needed (automatic failover working)

---

#### Pattern: Invalid Transaction Sequence

```
ERROR: Transaction failed - tx_bad_seq (source account sequence mismatch)
```

**Action**: Refresh source account state before building transaction

---

## Contacting Support

If you cannot resolve the issue using this guide, contact support with the following information:

### Required Information

1. **Error Details**
   - Error code and message
   - HTTP status code
   - Timestamp of occurrence

2. **Request Details**
   - API endpoint called
   - Request method (GET/POST)
   - Correlation ID (from response headers)

3. **Environment**
   - SDK version (`npm list @c-address-bridge/sdk`)
   - Node.js version (`node --version`)
   - Network (testnet/mainnet)

4. **Reproduction Steps**
   - Minimal code to reproduce
   - Input data (sanitized, no secrets)
   - Expected vs actual behavior

5. **Debug Logs**
   - Client-side logs (with debug enabled)
   - Correlation IDs for tracing
   - Transaction hashes (if applicable)

### Support Channels

- **Email**: support@bridge.example.com
- **Discord**: https://discord.gg/bridge-support
- **GitHub Issues**: https://github.com/C-Address-Onboarding-Bridge/issues
- **Status Page**: https://status.bridge.example.com

### Response Time SLA

- **Critical** (production down): < 1 hour
- **High** (major feature broken): < 4 hours
- **Medium** (minor issue, workaround available): < 1 business day
- **Low** (question, enhancement request): < 3 business days

---

## Additional Resources

- [API Documentation](https://docs.bridge.example.com/api)
- [SDK Reference](https://docs.bridge.example.com/sdk)
- [Integration Examples](https://github.com/C-Address-Onboarding-Bridge/examples)
- [Community Forum](https://community.bridge.example.com)
- [Status Page](https://status.bridge.example.com)

---

**Last Updated**: 2024-01-15  
**Version**: 1.0.0
