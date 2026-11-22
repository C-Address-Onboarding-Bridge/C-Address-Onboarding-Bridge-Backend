import { Router, Request, Response } from 'express';
import { sorobanService, SorobanRpcError } from '../services/soroban';
import { getQueueStats } from '../jobs/queue';

const router = Router();

const TX_HASH_REGEX = /^[0-9a-fA-F]{64}$/;

interface StatusCacheEntry {
  data: unknown;
  expiresAt: number;
}

const STATUS_CACHE_TTL_MS = 30_000;
const statusCache = new Map<string, StatusCacheEntry>();

function getCachedStatus(txHash: string): unknown | undefined {
  const entry = statusCache.get(txHash);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    statusCache.delete(txHash);
    return undefined;
  }
  return entry.data;
}

function setCachedStatus(txHash: string, data: unknown): void {
  statusCache.set(txHash, { data, expiresAt: Date.now() + STATUS_CACHE_TTL_MS });
}

export function invalidateStatusCache(txHash?: string): void {
  if (txHash) {
    statusCache.delete(txHash);
    return;
  }
  statusCache.clear();
}

router.get('/:txHash', async (req: Request, res: Response) => {
  const { txHash } = req.params;

  if (!TX_HASH_REGEX.test(txHash)) {
    return res.status(400).json({
      error: 'Invalid transaction hash',
      message: 'Transaction hash must be a 64-character hex string',
    });
  }

  const cached = getCachedStatus(txHash);
  if (cached !== undefined) {
    return res.json(cached);
  }

  try {
    const status = await sorobanService.getTransactionStatus(txHash);
    setCachedStatus(txHash, status);
    return res.json(status);
  } catch (error) {
    if (error instanceof SorobanRpcError) {
      return res.status(503).json({
        error: 'Soroban RPC unavailable',
        message: error.message,
      });
    }
    throw error;
  }
});

router.get('/queues', async (_req: Request, res: Response) => {
  try {
    const stats = await getQueueStats();
    return res.json(stats);
  } catch (error) {
    return res.status(500).json({
      error: 'Failed to fetch queue stats',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

router.get('/health', (_req: Request, res: Response) => {
  return res.json({ status: 'ok' });
});

export const statusRouter = router;
export default router;
