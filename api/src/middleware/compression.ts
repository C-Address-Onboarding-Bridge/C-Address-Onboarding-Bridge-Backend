import compression from 'compression';
import { Request, Response } from 'express';
import { config } from '../config';

const SKIP_CONTENT_TYPES = [
  'image/',
  'video/',
  'audio/',
  'application/zip',
  'application/gzip',
  'application/x-brotli',
  'application/octet-stream',
];

function shouldCompress(req: Request, res: Response): boolean {
  const ct = res.getHeader('Content-Type') as string | undefined;
  if (ct && SKIP_CONTENT_TYPES.some((prefix) => ct.startsWith(prefix))) {
    return false;
  }
  return compression.filter(req, res);
}

export const compressionMiddleware = compression({
  filter: shouldCompress,
  threshold: config.compression.threshold,
  level: config.compression.level,
});
