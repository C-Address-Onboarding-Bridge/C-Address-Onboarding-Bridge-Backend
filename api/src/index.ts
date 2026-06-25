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
import { webhookAdminRouter } from './routes/webhookAdmin';
import { apiKeyAuth } from './middleware/auth';
import { errorHandler } from './middleware/error';
import { securityMiddleware, contentTypeEnforcement } from './middleware/security';

export const logger = pino({ level: config.logLevel });

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

// Security: injection detection, parameter pollution, size limits
app.use('/api', securityMiddleware);
// Security: Content-Type enforcement on mutation endpoints
app.use('/api/v1', contentTypeEnforcement);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

app.use('/api/v1/quote', apiKeyAuth, quoteRouter);
app.use('/api/v1/fund', apiKeyAuth, fundingRouter);
app.use('/api/v1/status', apiKeyAuth, statusRouter);
app.use('/api/v1/offramp', apiKeyAuth, offrampRouter);
app.use('/api/v1/cex', apiKeyAuth, cexRouter);
app.use('/api/webhook/moonpay', moonpayWebhookRouter);
app.use('/api/v1/webhooks', apiKeyAuth, webhookAdminRouter);

app.use(errorHandler);

if (process.env.NODE_ENV !== 'test') {
  app.listen(config.port, config.host, () => {
    logger.info({ port: config.port }, 'bridge api server started');
  });
}

export { app };
