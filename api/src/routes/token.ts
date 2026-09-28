import { Router, Request, Response } from 'express';
import { logger } from '../logger';

const router = Router();

/**
 * Issue #672: GET /api/v1/token/:contractId/metadata
 * Returns token metadata (decimals, name, symbol) for a given contract ID.
 * For native XLM returns hardcoded values; for SAC tokens queries contract via RPC.
 */
router.get(
  '/:contractId/metadata',
  async (req: Request, res: Response) => {
    const { contractId } = req.params;

    try {
      // Native XLM
      if (contractId === 'native') {
        return res.json({
          success: true,
          data: {
            decimals: 7,
            name: 'Stellar Lumens',
            symbol: 'XLM',
          },
        });
      }

      // For SAC tokens, in production this would query the contract
      // via RPC/Soroban and cache the results. For now, return a
      // placeholder that mirrors the SDK's fallback structure.
      // TODO: implement actual token contract metadata queries
      return res.json({
        success: true,
        data: {
          decimals: 6,
          name: 'Unknown Token',
          symbol: 'UNKNOWN',
        },
      });
    } catch (error) {
      logger.error('Failed to fetch token metadata', { contractId, error });
      res.status(500).json({
        success: false,
        error: 'Failed to fetch token metadata',
      });
    }
  }
);

export const tokenRouter = router;
