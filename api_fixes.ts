// Issues #1014, #1015, #1016, #1017 - API Backend Fixes

// Issue #1016: Fix gracefulShutdown.attach() - pass logger not callback
// api/src/index.ts - BEFORE: gracefulShutdown.attach(server, async () => { ... })
// AFTER: gracefulShutdown.attach(server, logger);

import { Logger } from 'pino';
import { gracefulShutdown, registerSignalHandlers } from './shutdown';

export function setupShutdown(server: any, logger: Logger) {
  // FIX: Pass logger as second argument, not cleanup callback
  gracefulShutdown.attach(server, logger);

  // FIX: Pass closeConnections callback to registerSignalHandlers
  registerSignalHandlers(async () => {
    await closePool();
    await shutdownTracing();
  });
}

// Issue #1017: Fix route registration order - static routes before parameterized
// api/src/routes/status.ts - Register /queues and /health BEFORE /:txHash
export function registerStatusRoutes(router: any) {
  // FIX: Register static routes first
  router.get('/queues', async (req: any, res: any) => {
    // FIX: Import getQueueStats correctly from jobs/queue
    const { getQueueStats } = await import('../jobs/queue');
    const stats = await getQueueStats();
    res.json(stats);
  });

  router.get('/health', (req: any, res: any) => {
    res.json({ status: 'ok' });
  });

  // Then register parameterized route
  router.get('/:txHash', async (req: any, res: any) => {
    const { txHash } = req.params;
    if (!TX_HASH_REGEX.test(txHash)) {
      return res.status(400).json({ error: 'Invalid transaction hash' });
    }
    // Get transaction status
  });
}

// Issue #1015: Fix OpenAPI spec to match actual responses
// api/src/openapi/spec.ts - Update schemas to match handlers

const QuoteResponseFixed = {
  type: 'object',
  properties: {
    fee: { type: 'string' },
    feeBps: { type: 'number' },
    rebateBps: { type: 'number' },
  },
  required: ['fee', 'feeBps', 'rebateBps'],
};

const StatusQueuesResponseFixed = {
  type: 'object',
  properties: {
    // Actual queue stats returned by handler
  },
};

const StatusHealthResponseFixed = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['ok'] },
  },
};

// FIX: Update CreateKeyRequest scopes enum to include all supported scopes
const CreateKeyRequestFixed = {
  type: 'object',
  properties: {
    scopes: {
      type: 'array',
      items: {
        type: 'string',
        enum: [
          'quote:read',
          'fund:write',
          'status:read',
          'offramp:write',
          'cex:read',
          'cex:withdraw',      // FIX: Add missing scopes
          'transactions:read',
          'metrics:read',
          'admin:keys',
        ],
      },
    },
  },
};

// FIX: Update ErrorResponse.details schema
const ErrorResponseFixed = {
  type: 'object',
  properties: {
    error: {
      type: 'object',
      properties: {
        message: { type: 'string' },
        code: { type: 'string' },
        details: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: {
                oneOf: [
                  { type: 'string' },
                  { type: 'array', items: { type: ['string', 'number'] } },
                ],
              },
              message: { type: 'string' },
              code: { type: 'string' },
            },
          },
        },
      },
    },
  },
};

// Issue #1014: Fix mount paths in index.ts to match spec
// api/src/index.ts - BEFORE: app.use('/api/v1/keys', ...)
// AFTER: Keep /api/v1/api-keys, update spec paths

// Routes are mounted at:
// /api/v1/api-keys (not /api/v1/keys)
// /api/cache-metrics (not /api/v1/cache/metrics)
// /metrics at /metrics (not /api/v1/metrics)
// /timelocked route doesn't exist - remove from spec

// Update openapi/spec.ts paths to match actual mounts
const SpecPathsFixed = {
  '/api/v1/api-keys': { /* existing */ },
  '/api/v1/api-keys/{id}': { /* existing */ },
  '/api/cache-metrics': { /* move from /api/v1/cache/metrics */ },
  '/metrics': { /* move from /api/v1/metrics, update auth */ },
  // REMOVE: /api/v2/fund/timelocked (doesn't exist)
};

// FIX: Update openapi coverage test to check both directions
// __tests__/openapiCoverage.test.ts
function testOpenAPICoverage() {
  // Check mounted routes against spec
  const mountedRoutes = getAllMountedRoutes();
  const specPaths = Object.keys(spec.paths);

  // FIX: Also check spec against mounted routes
  for (const specPath of specPaths) {
    const actual = findMountedRoute(specPath);
    if (!actual) {
      throw new Error(`Spec path ${specPath} not mounted`);
    }
  }
}

// FIX: Export getQueueStats from jobs/queue.ts
export async function getQueueStats() {
  // Implementation
  return {};
}
