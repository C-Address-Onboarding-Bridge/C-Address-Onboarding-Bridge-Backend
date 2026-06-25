import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import pino from 'pino';
import { config } from './config';
import { fundingRouter } from './routes/funding';
import { quoteRouter } from './routes/quote';
import { statusRouter } from './routes/status';
import { offrampRouter } from './routes/offramp';
import { cexRouter } from './routes/cex';
import { moonpayWebhookRouter } from './routes/webhook';
import { apiKeyAuth } from './middleware/auth';
import { errorHandler } from './middleware/error';
import { CircuitBreaker } from './circuit-breaker';

export const logger = pino({ level: config.logLevel });

export const circuitBreakers = new Map<string, CircuitBreaker>([
  ['soroban', new CircuitBreaker('soroban')],
  ['moonpay', new CircuitBreaker('moonpay')],
  ['transak', new CircuitBreaker('transak')],
  ['cex', new CircuitBreaker('cex')],
]);

const app = express();

app.use(helmet());
app.use(cors());

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limit', message: 'too many requests, try again later' },
});
app.use(limiter);

app.use('/api/webhook', express.text({ type: '*/*' }));
app.use('/api', express.json({ limit: '32kb' }));

app.get('/health', (_req, res) => {
  const circuits: Record<string, string> = {};
  for (const [name, cb] of circuitBreakers) {
    circuits[name] = cb.getState();
  }
  res.json({ status: 'ok', timestamp: Date.now(), circuits });
});

app.use('/api/v1/quote', apiKeyAuth, quoteRouter);
app.use('/api/v1/fund', apiKeyAuth, fundingRouter);
app.use('/api/v1/status', apiKeyAuth, statusRouter);
app.use('/api/v1/offramp', apiKeyAuth, offrampRouter);
app.use('/api/v1/cex', apiKeyAuth, cexRouter);
app.use('/api/webhook/moonpay', moonpayWebhookRouter);

app.use(errorHandler);

if (process.env.NODE_ENV !== 'test') {
  app.listen(config.port, config.host, () => {
    logger.info({ port: config.port }, 'bridge api server started');
  });
}

export { app };
