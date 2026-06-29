# C-Address Onboarding Bridge

> Route funds directly to Soroban smart accounts (C-addresses) without requiring a traditional G-address. The onboarding layer for all Soroban dApps.

[![Rust](https://img.shields.io/badge/Rust-1.96+-orange.svg)](https://rustup.rs)
[![Soroban](https://img.shields.io/badge/Soroban-21.0+-blue.svg)](https://soroban.stellar.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3+-3178C6.svg)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

---

## The Problem

The shift to C-addresses (Soroban smart accounts) is critical for next-generation dApps on Stellar, but two major adoption blockers persist:

1. **Funding friction**: Users cannot easily fund a C-address without first using a traditional G-address
2. **Lack of tooling**: No modern onboarding flow exists around the Smart Account standard by OpenZeppelin

**In plain terms**: new users can't interact with Soroban dApps directly. They need an old-style Stellar account first, which kills UX for mainstream adoption.

## The Solution

A protocol and backend infrastructure that lets anyone fund a Soroban smart account (C-address) directly from a CEX withdrawal, a credit card, or an existing G-address — without the user understanding the underlying account model.

### Comparison to Account Abstraction

| Concept | Ethereum | Stellar (this project) |
|---------|----------|----------------------|
| Smart accounts | EIP-4337 Account Abstraction | Soroban C-addresses |
| Funding layer | Paymasters | Onboarding Bridge contract |
| Wallet integration | ERC-4337 SDK | TypeScript SDK |
| Fiat on-ramp | Moonpay/Transak integration | Same (via off-ramp module) |

---

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
│   Wallet/   │────▶│  SDK Client  │────▶│   API Server    │
│    dApp     │     │  (TypeScript)│     │   (Express)     │
└─────────────┘     └──────────────┘     └────────┬────────┘
                                                   │
                    ┌──────────────────────────────┼──────────────────┐
                    │              ┌───────────────▼────────┐        │
                    │              │   Onboarding Bridge    │        │
                    │              │   Soroban Contract     │        │
                    │              └───────────┬────────────┘        │
                    │                          │                     │
                    │              ┌───────────▼────────────┐        │
                    │              │    C-Address Target    │        │
                    │              └────────────────────────┘        │
                    │                                                │
                    │  ┌──────────┐  ┌──────────┐  ┌─────────────┐  │
                    │  │  Moonpay  │  │  Transak  │  │ CEX Router  │  │
                    │  └──────────┘  └──────────┘  └─────────────┘  │
                    └────────────────────────────────────────────────┘
```

### Funding Flows

```
G-Address ──▶ Bridge Contract ──▶ C-Address
CEX        ──▶ Bridge Contract ──▶ C-Address
Credit Card ──▶ Moonpay/Transak ──▶ Bridge Contract ──▶ C-Address
```

---

## Dependency Vulnerability Monitoring

The repository runs automated dependency vulnerability scanning through GitHub Actions and scheduled audits. The workflow currently:

- runs a weekly dependency audit on the default branch and for pull requests,
- publishes a machine-readable audit report plus a human-readable summary artifact,
- tracks severity-based patch SLAs of critical (24 hours), high (7 days), moderate (30 days), and low (next release),
- sends Slack notifications when the workflow is configured with a webhook secret.

Accepted-risk overrides must be documented in the issue tracker with the dependency name, severity, owner, and expiry date, and they should be reviewed on the next scheduled scan.

## Project Structure

```
├── contracts/onboarding-bridge/      # Soroban smart contract (Rust)
│   ├── Cargo.toml
│   └── src/
│       ├── lib.rs                    # Core contract logic
│       └── test.rs                   # Contract unit tests
│
├── api/                              # Express API server
│   ├── package.json
│   └── src/
│       ├── index.ts                  # Server entry point
│       ├── config.ts                 # Environment configuration
│       ├── routes/                   # REST API routes
│       │   ├── quote.ts              # GET  /api/v1/quote
│       │   ├── funding.ts            # POST /api/v1/fund
│       │   ├── status.ts             # GET  /api/v1/status/:txHash
│       │   ├── offramp.ts            # POST /api/v1/offramp/{moonpay,transak}
│       │   └── cex.ts                # POST /api/v1/cex/route
│       ├── services/                 # Business logic
│       │   ├── soroban.ts            # Soroban RPC client
│       │   ├── moonpay.ts            # Moonpay integration
│       │   ├── transak.ts            # Transak integration
│       │   └── cex.ts                # CEX routing
│       └── middleware/
│           └── error.ts              # Error handling
│
├── sdk/                              # TypeScript SDK
│   ├── package.json
│   └── src/
│       ├── index.ts                  # Public API exports
│       ├── bridge.ts                 # BridgeClient class
│       ├── types.ts                  # TypeScript type definitions
│       └── utils.ts                  # Address validation, fee calculation
│
├── offramp/                          # Standalone off-ramp modules
│   ├── moonpay.ts                    # Moonpay widget + webhook verification
│   └── transak.ts                    # Transak widget generation
│
├── cex/                              # CEX withdrawal routing
│   ├── withdrawal-router.ts          # Pluggable routing engine
│   └── README.md                     # Exchange integration guide
│
├── .env.example                      # Environment variables template
├── tsconfig.base.json                # Shared TypeScript config
└── package.json                      # Workspace root
```

---

## Soroban Smart Contract

### Contract Address
`onboarding-bridge` — deployed on Stellar testnet/mainnet.

### Interface

| Function | Auth | Description |
|----------|------|-------------|
| `initialize(admin, fee_bps)` | Admin | One-time initialization |
| `version()` | None | Returns contract version |
| `admin()` | None | Returns admin address |
| `fee_bps()` | None | Returns fee in basis points |
| `accumulated_fees()` | None | Returns total fees collected |
| `set_fee(new_fee_bps)` | Admin | Update fee rate |
| `fund_c_address(source, target, token, amount, memo)` | Source | Route funds from G → C address |
| `withdraw_fees(to, token, amount)` | Admin | Withdraw accumulated fees |
| `route_from_exchange(exchange, target, token, amount, memo)` | Exchange | CEX → C-address routing |

### Fee Model

Fees are calculated in basis points (1 bps = 0.01%):
- Configurable by admin (max 10000 bps = 100%)
- Deducted from the transfer amount
- Accumulated in the contract for admin withdrawal
- Emitted in `funded` event for transparency

### Events

```rust
// On initialization
(event: "initialize", admin: Address, fee_bps: u32)

// On funding
(event: "funded", source: Address, target: Address, amount: i128, fee: i128, memo: String)

// On fee update
(event: "set_fee", new_fee_bps: u32)

// On fee withdrawal
(event: "withdrawn", to: Address, amount: i128)
```

---

## API Versioning

The API now supports URL-based versioning and Accept header versioning. Version negotiation is handled by the middleware and returns standard deprecation headers on v1 responses.

- `v1`: current stable endpoint family with deprecation headers and a sunset date
- `v2`: compatible successor endpoints that can coexist with `v1`
- `alpha -> beta -> stable -> deprecated -> sunset`: lifecycle is documented in the changelog below

### Version Lifecycle and Changelog

| Version | Status | Notes |
|---------|--------|-------|
| `v1` | deprecated | Legacy endpoints with deprecation and sunset headers |
| `v2` | beta | Newer routing surface with version negotiation support |

## API Reference

### `GET /api/v1/quote`

Get a funding quote including fee estimates.

**Query Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| `sourceAsset` | `string` | Asset code (e.g. `XLM`, `USDC`) |
| `amount` | `string` | Amount in stroops (integer string) |
| `targetAddress` | `string` | Destination C-address |

**Response:**
```json
{
  "estimatedFee": "3",
  "expectedReceive": "997",
  "feeBps": 30,
  "rate": "1.0"
}
```

### `POST /api/v1/fund`

Submit a funding transaction to the Soroban bridge contract.

**Request Body:**
```json
{
  "sourceAddress": "G...",
  "targetAddress": "C...",
  "tokenAddress": "CC...",
  "amount": "1000",
  "memo": "onboarding",
  "sourceSecretKey": "S..."
}
```

**Response:**
```json
{
  "status": "success",
  "hash": "a1b2c3d4..."
}
```

### `GET /api/v1/status/:txHash`

Check the status of a funding transaction.

**Response:**
```json
{
  "status": "success",
  "hash": "a1b2c3d4..."
}
```

### `POST /api/v1/offramp/moonpay`

Generate a Moonpay widget URL for credit card → C-address funding.

**Request Body:**
```json
{
  "currencyCode": "xlm",
  "walletAddress": "C...",
  "walletNetwork": "stellar",
  "baseCurrencyAmount": 100,
  "baseCurrencyCode": "USD",
  "email": "user@example.com"
}
```

**Response:**
```json
{
  "url": "https://buy.moonpay.com?apiKey=..."
}
```

### `POST /api/v1/offramp/transak`

Generate a Transak widget URL.

**Request Body:**
```json
{
  "walletAddress": "C...",
  "network": "stellar",
  "fiatCurrency": "USD",
  "cryptoCurrency": "XLM",
  "fiatAmount": 100
}
```

**Response:**
```json
{
  "url": "https://global-stg.transak.com?apiKey=..."
}
```

### `POST /api/v1/cex/route`

Route a CEX withdrawal to a C-address.

**Request Body:**
```json
{
  "exchange": "binance",
  "sourceAsset": "XLM",
  "amount": "10000000",
  "targetCAddress": "C...",
  "targetNetwork": "stellar",
  "memo": "bridge:binance:ABCD1234"
}
```

**Response:**
```json
{
  "status": "pending",
  "withdrawalId": "bin-1712345678-a1b2c3",
  "estimatedArrival": "5-30 minutes",
  "fee": "0.0001"
}
```

---

## SDK Usage

### Installation

```bash
npm install @c-address-bridge/sdk
```

### Multi-language examples

Python, Rust, Go, and Java examples live in [`examples/`](examples/). Each includes a thin HTTP client, Docker support, and CI verification:

```bash
node examples/mock-server/server.mjs   # terminal 1
export BRIDGE_BASE_URL=http://localhost:3099
cd examples/python && python main.py     # or rust / go / java
```

See [examples/README.md](examples/README.md) and [video walkthroughs](docs/video-walkthroughs.md).

### Quick Start

```typescript
import { BridgeClient, utils } from '@c-address-bridge/sdk';

const client = new BridgeClient({
  baseUrl: 'https://api.bridge.example.com',
  apiKey: 'your-api-key',
});

// Get a quote
const quote = await client.getQuote({
  sourceAsset: 'XLM',
  amount: '10000000',  // 1 XLM in stroops
  targetAddress: 'C...',
});

console.log(`Fee: ${quote.estimatedFee} stroops`);
console.log(`You receive: ${quote.expectedReceive} stroops`);

// Fund a C-address
const result = await client.fundAddress({
  sourceAddress: 'G...',
  targetAddress: 'C...',
  tokenAddress: 'CC...',
  amount: '10000000',
  sourceSecretKey: 'S...',
});

console.log(`Transaction hash: ${result.hash}`);

// Check status
const status = await client.getStatus(result.hash);
console.log(`Status: ${status.status}`);

// Validate addresses
console.log(utils.isValidStellarAddress('C...'));  // true
console.log(utils.isCAddress('C...'));             // true
console.log(utils.isGAddress('G...'));             // true
console.log(utils.isGAddress('C...'));             // false

// Calculate fees
const fee = utils.calculateFee(1000n, 30);  // 30 bps fee
console.log(`Fee: ${fee} stroops`);
```

### Off-ramp Widget URLs

```typescript
// Moonpay — credit card to C-address
const moonpay = await client.createMoonpayUrl({
  walletAddress: 'C...',
  currencyCode: 'xlm',
  walletNetwork: 'stellar',
  baseCurrencyAmount: 100,
  baseCurrencyCode: 'USD',
});

// Transak — credit card to C-address
const transak = await client.createTransakUrl({
  walletAddress: 'C...',
  network: 'stellar',
  fiatCurrency: 'USD',
  cryptoCurrency: 'XLM',
  fiatAmount: 100,
});
```

### CEX Withdrawal Routing

```typescript
const result = await client.routeCexWithdrawal({
  exchange: 'coinbase',
  sourceAsset: 'USDC',
  amount: '5000000',
  targetCAddress: 'C...',
  targetNetwork: 'stellar',
});
```

---

## CEX Integration

Exchanges can integrate the bridge by implementing the `WithdrawalRouter`:

```typescript
import { WithdrawalRouter, defaultCexHandlers } from './cex/withdrawal-router';

const router = new WithdrawalRouter();
router.registerExchange('my-exchange', {
  name: 'my-exchange',
  apiBaseUrl: 'https://api.my-exchange.com',
}, async (req, config) => {
  // Implement withdrawal API call
  // Route through bridge contract
  return {
    success: true,
    withdrawalId: 'tx-...',
    status: 'pending',
    estimatedCompletion: '5-30 minutes',
  };
});
```

Memo format for tracking: `bridge:{exchange_name}:{c_address_suffix}`

---

## Development

### Prerequisites

- Rust 1.96+ ([install](https://rustup.rs))
- Node.js 20+ ([install](https://nodejs.org))
- npm 9+

### Setup

```bash
# Clone
git clone https://github.com/C-Address-Onboarding-Bridge/C-Address-Onboarding-Bridge-Backend.git
cd C-Address-Onboarding-Bridge-Backend

# Install JS dependencies
npm install

# Copy environment config
cp .env.example .env
```

### Build

```bash
# Build Soroban contract
cd contracts/onboarding-bridge
cargo build

# Build TypeScript packages
cd ../..
npm run build
```

### Test

```bash
# Run Soroban contract tests
cargo test

# Run JS/TS tests
npm run test --workspaces
```

### Run API Server

```bash
npm run dev -w api
```

Server starts at `http://localhost:3001`. Health check: `GET /health`.

---

## Deployment

### Soroban Contract

```bash
cd contracts/onboarding-bridge

# Build optimized WASM
cargo build --target wasm32-unknown-unknown --release

# Deploy using soroban-cli
soroban contract deploy \
  --wasm target/wasm32-unknown-unknown/release/onboarding_bridge.wasm \
  --source <admin-secret> \
  --rpc-url https://soroban-rpc.testnet.stellar.org \
  --network-passphrase "Test SDF Network ; September 2015"

# Initialize
soroban contract invoke \
  --id <contract-id> \
  --source <admin-secret> \
  --rpc-url https://soroban-rpc.testnet.stellar.org \
  --network-passphrase "Test SDF Network ; September 2015" \
  -- \
  initialize \
  --admin <admin-address> \
  --fee_bps 30
```

### API Server

```bash
# Set environment variables
export SOROBAN_RPC_URL=https://soroban-rpc.testnet.stellar.org
export BRIDGE_CONTRACT_ID=<deployed-contract-id>
export BRIDGE_FEE_BPS=30
export MOONPAY_API_KEY=your-key
export TRANSAK_API_KEY=your-key
export PORT=3001

# Start
npm start -w api
```

### Blue-Green Deployment

```bash
export BLUE_URL=https://blue.example.com
export GREEN_URL=https://green.example.com
export DEPLOY_GREEN_COMMAND='bash ./scripts/deploy.sh --network testnet'
export SWITCH_TRAFFIC_COMMAND='echo "switch traffic to {{color}}"'
export POST_SWITCH_CHECK_COMMAND='bash ./scripts/smoke-test.sh'

npm run deploy:blue-green
```

The blue-green flow deploys to the inactive environment, runs smoke tests, switches traffic, keeps the previous environment warm for rollback, drains old connections, and records the active color for the next release.

---

## Architecture Decision Records

Architectural decisions are documented in [docs/adr/README.md](docs/adr/README.md). Use the ADR template at [docs/adr/template.md](docs/adr/template.md) for new proposals.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SOROBAN_RPC_URL` | Yes | `https://soroban-rpc.testnet.stellar.org` | Soroban RPC endpoint |
| `SOROBAN_NETWORK_PASSPHRASE` | Yes | `Test SDF Network ; September 2015` | Network passphrase |
| `BRIDGE_CONTRACT_ID` | Yes | — | Deployed contract ID |
| `BRIDGE_FEE_BPS` | No | `30` | Fee in basis points |
| `MOONPAY_API_KEY` | For Moonpay | — | Moonpay API key |
| `MOONPAY_SECRET_KEY` | For webhooks | — | Moonpay webhook secret |
| `TRANSAK_API_KEY` | For Transak | — | Transak API key |
| `TRANSAK_ENVIRONMENT` | No | `STAGING` | `STAGING` or `PRODUCTION` |
| `PORT` | No | `3001` | API server port |
| `HOST` | No | `0.0.0.0` | API server host |
| `LOG_LEVEL` | No | `info` | Pino log level |

---

## Test Results

```
┌─────────────────────────────┬────────────┬──────────┬─────────┐
│ Component                   │   Tests    │  Passed  │  Build  │
├─────────────────────────────┼────────────┼──────────┼─────────┤
│ Soroban Contract (Rust)     │     4      │    4     │   ✓     │
│ API Server (TypeScript)     │     7      │    7     │   ✓     │
│ TypeScript SDK              │     6      │    6     │   ✓     │
└─────────────────────────────┴────────────┴──────────┴─────────┘
```

---

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

---

## License

MIT — see [LICENSE](LICENSE) for details.

---

## Related Projects

- [Soroban Smart Accounts by OpenZeppelin](https://github.com/OpenZeppelin/soroban-accounts)
- [Stellar Soroban SDK](https://github.com/stellar/soroban-sdk)
- [EIP-4337 Account Abstraction](https://eips.ethereum.org/EIPS/eip-4337)
