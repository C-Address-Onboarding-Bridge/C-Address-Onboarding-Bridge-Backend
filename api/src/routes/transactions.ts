import { Router, Request, Response } from 'express';
import { rbacAuth } from '../middleware/rbacAuth';
import {
  listTransactions,
  serializeTransactionsCsv,
  type TransactionQueryParams,
  type TransactionStatus,
} from '../services/transactions';

export const transactionsRouter = Router();

transactionsRouter.get('/', rbacAuth, (req: Request, res: Response) => {
  const status = typeof req.query.status === 'string' ? (req.query.status as TransactionStatus) : undefined;
  const fromDate = typeof req.query.fromDate === 'string' ? req.query.fromDate : undefined;
  const toDate = typeof req.query.toDate === 'string' ? req.query.toDate : undefined;
  const minAmount = typeof req.query.minAmount === 'string' ? req.query.minAmount : undefined;
  const maxAmount = typeof req.query.maxAmount === 'string' ? req.query.maxAmount : undefined;
  const limit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : undefined;
  const offset = typeof req.query.offset === 'string' ? parseInt(req.query.offset, 10) : undefined;
  const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
  const format = typeof req.query.format === 'string' && req.query.format === 'csv' ? 'csv' : 'json';

  const params: TransactionQueryParams = {
    status,
    fromDate,
    toDate,
    minAmount,
    maxAmount,
    limit,
    offset,
    cursor,
    format,
  };

  const result = listTransactions(params);
  if (format === 'csv') {
    res.type('text/csv').send(serializeTransactionsCsv(result.data));
    return;
  }

  res.json({
    data: result.data,
    nextCursor: result.nextCursor,
    hasMore: result.hasMore,
  });
});
