import express, { Request, Response, NextFunction } from 'express';

/** JSON body limit for every /api route without a more specific parser. */
export const DEFAULT_JSON_LIMIT = '32kb';

/**
 * Funding bodies carry a signedXdr of up to MAX_XDR_BYTE_LENGTH (64 KiB)
 * characters plus, for /fund/batch, up to 100 recipients (~11 KB), so they
 * need more room than the default or valid requests never reach validation.
 */
export const FUNDING_JSON_LIMIT = '128kb';

export const FUNDING_PATHS = ['/api/v1/fund', '/api/v2/fund', '/api/fund'];

/**
 * JSON parser for the funding routes. A body over the limit is reported with
 * the same XDR_TOO_LARGE code the XDR validator uses instead of a bare 413.
 */
export const fundingJsonParser = [
  express.json({ limit: FUNDING_JSON_LIMIT }),
  (err: Error & { type?: string }, _req: Request, res: Response, next: NextFunction) => {
    if (err.type === 'entity.too.large') {
      res.status(413).json({
        error: 'XDR_TOO_LARGE',
        message: `request body exceeds the ${FUNDING_JSON_LIMIT} limit for funding requests`,
      });
      return;
    }
    next(err);
  },
];
