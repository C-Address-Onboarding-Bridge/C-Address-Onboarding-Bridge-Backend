import { NextFunction, Request, Response } from 'express';

/**
 * Wraps an async Express handler so a rejected promise is forwarded to
 * `next(err)` instead of becoming an unhandled rejection. Express 4 does not
 * do this automatically for async handlers, which otherwise leaves the
 * request hanging until client timeout.
 */
export function asyncHandler<Req extends Request = Request, Res extends Response = Response>(
  fn: (req: Req, res: Res, next: NextFunction) => Promise<unknown>,
) {
  return (req: Req, res: Res, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}
