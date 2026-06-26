import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import pino from 'pino';
import { config } from './config';
import { fundingRouter } from './routes/funding';
import { quoteRouter } from './routes/quote';
import { statusRouter } from './routes/status';
import { offrampRouter } from './routes/offramp';
import { cexRouter } from './routes/cex';
import { moonpayWebhookRouter } from './routes/webhook';
import { webhookAdminRouter } from './routes/webhookAdmin';
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

app.use(versionCompatibility);
app.use(rateLimitMiddleware);
app.use(applyRateLimitHeaders);

app.use('/api/webhook', express.text({ type: '*/*' }));
app.use('/api', express.json({ limit: '32kb' }));

// Security: injection detection, parameter pollution, size limits
app.use('/api', securityMiddleware);
// Security: Content-Type enforcement on mutation endpoints
app.use('/api/v1', contentTypeEnforcement);

app.get('/health', (_req, res) => {
  const circuits: Record<string, string> = {};
  for (const [name, cb] of circuitBreakers) {
    circuits[name] = cb.getState();
  }
  res.json({ status: 'ok', timestamp: Date.now(), circuits });
});

app.get('/api/v1/deprecations', (_req, res) => {
  res.json({
    version: 'v1',
    deprecated: true,
    sunset: '2027-12-31',
    features: [
      'legacy quote endpoints',
      'legacy funding routing',
      'legacy status polling',
    ],
  });
});

app.use('/api/v1/quote', apiKeyAuth, quoteRouter);
app.use('/api/v2/quote', apiKeyAuth, quoteRouter);
app.use('/api/v1/fund', apiKeyAuth, fundingRouter);
app.use('/api/v2/fund', apiKeyAuth, fundingRouter);
app.use('/api/v1/status', apiKeyAuth, statusRouter);
app.use('/api/v2/status', apiKeyAuth, statusRouter);
app.use('/api/v1/offramp', apiKeyAuth, offrampRouter);
app.use('/api/v2/offramp', apiKeyAuth, offrampRouter);
app.use('/api/v1/cex', apiKeyAuth, cexRouter);
app.use('/api/v2/cex', apiKeyAuth, cexRouter);
app.use('/api/quote', apiKeyAuth, quoteRouter);
app.use('/api/fund', apiKeyAuth, fundingRouter);
app.use('/api/status', apiKeyAuth, statusRouter);
app.use('/api/offramp', apiKeyAuth, offrampRouter);
app.use('/api/cex', apiKeyAuth, cexRouter);
app.use('/api/webhook/moonpay', moonpayWebhookRouter);
app.use('/api/v1/webhooks', apiKeyAuth, webhookAdminRouter);

app.use(errorHandler);

if (process.env.NODE_ENV !== 'test') {
  app.listen(config.port, config.host, () => {
    logger.info({ port: config.port }, 'bridge api server started');
  });
}

export { app };
