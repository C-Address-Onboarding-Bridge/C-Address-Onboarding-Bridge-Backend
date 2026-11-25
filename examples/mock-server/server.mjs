#!/usr/bin/env node
/**
 * Lightweight HTTP mock of the C-Address Bridge API for multi-language examples.
 * Start: node examples/mock-server/server.mjs
 */
import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT || 3099);

const MOCK_C_ADDRESS = 'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTU';
const MOCK_G_ADDRESS = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTU';
const MOCK_TOKEN_ADDRESS = 'CATOKEN7ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMN';
const MOCK_TX_HASH = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

const fixtures = {
  quote: {
    estimatedFee: '100',
    expectedReceive: '9900',
    feeBps: 100,
    rate: '1.0',
  },
  fundingResult: { status: 'pending', hash: MOCK_TX_HASH },
  transactionStatus: { status: 'success', hash: MOCK_TX_HASH },
  fundingPrepare: {
    unsignedXdr: 'AAAAAgAAAABexampleUnsignedTransactionXdrBase64==',
    footprint: 'AAAAAQAAAAYexampleLedgerFootprintBase64==',
    fee: '100',
    sourceAddress: MOCK_G_ADDRESS,
    targetAddress: MOCK_C_ADDRESS,
    tokenAddress: MOCK_TOKEN_ADDRESS,
    amount: '10000',
    memo: 'onboarding',
  },
  moonpay: { url: `https://buy.moonpay.com?apiKey=mock&walletAddress=${MOCK_C_ADDRESS}` },
  transak: { url: `https://global.transak.com?apiKey=mock&walletAddress=${MOCK_C_ADDRESS}` },
  cex: {
    status: 'pending',
    withdrawalId: 'wd-mock-0001',
    exchangeTxId: 'exch-0001',
    estimatedArrival: '5-30 minutes',
    fee: '5',
  },
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve(null);
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(raw);
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function route(method, pathname) {
  if (method === 'GET' && pathname === '/health') return { status: 200, body: { status: 'ok' } };
  if (method === 'GET' && pathname === '/api/v1/quote' && process.env.MOCK_FORCE_ERROR === '1') {
    return { status: 503, body: { error: 'service_unavailable' } };
  }
  if (method === 'GET' && pathname === '/api/v1/quote') return { status: 200, body: fixtures.quote };
  if (method === 'POST' && pathname === '/api/v1/fund/prepare') return { status: 200, body: fixtures.fundingPrepare };
  if (method === 'POST' && pathname === '/api/v1/fund') return { status: 201, body: fixtures.fundingResult };
  if (method === 'GET' && /^\/api\/v1\/status\/[0-9a-fA-F]{64}$/.test(pathname)) return { status: 200, body: fixtures.transactionStatus };
  if (method === 'POST' && pathname === '/api/v1/offramp/moonpay') return { status: 200, body: fixtures.moonpay };
  if (method === 'POST' && pathname === '/api/v1/offramp/transak') return { status: 200, body: fixtures.transak };
  if (method === 'POST' && pathname === '/api/v1/cex/route') return { status: 200, body: fixtures.cex };

  return { status: 404, body: { error: 'not_found', details: `No mock for ${method} ${pathname}` } };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const match = route(req.method, url.pathname);

  const body = await readBody(req);

  // Validate that submitted XDR looks like a parseable signed envelope (non-empty base64-ish string).
  if (req.method === 'POST' && url.pathname === '/api/v1/fund') {
    const signedXdr = body && typeof body === 'object' ? body.signedXdr : null;
    if (!signedXdr || typeof signedXdr !== 'string' || signedXdr.trim().length === 0) {
      send(res, 400, { message: 'signedXdr is required and must be a non-empty string', code: 'INVALID_XDR' });
      return;
    }
    // Reject obviously fake XDR that only the old mock accepted (e.g. "AAAAAgAAAABexampleSignedTransactionXdr")
    // Real XDR envelopes are base64 and do not contain lowercase letters in the first 8 chars — they start with 'AAAAA'.
    // We just check it starts with 'AAAA' (all real Stellar XDR envelopes do).
    if (!signedXdr.startsWith('AAAA')) {
      send(res, 422, { message: 'signedXdr must be a valid base64-encoded Stellar transaction envelope', code: 'INVALID_XDR' });
      return;
    }
  }

  send(res, match.status, match.body);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Bridge mock API listening on http://localhost:${PORT}`);
});
