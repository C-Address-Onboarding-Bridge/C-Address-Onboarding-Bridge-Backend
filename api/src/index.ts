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
import { moonpayWebhookRouter, transakWebhookRouter } from './routes/webhook';
import { webhookAdminRouter } from './routes/webhookAdmin';
import { apiKeysRouter } from './routes/apiKeys';
import { rbacAuth, seedLegacyKeys } from './middleware/rbacAuth';
import { registerWebhookVerifier, moonpayVerifier, transakVerifier } from './middleware/webhookVerification';
import { compressionMiddleware } from './middleware/compression';
import { errorHandler } from './middleware/error';
import { CircuitBreaker } from './circuit-breaker';
import { versionCompatibility } from './middleware/versioning';
import { rateLimitMiddleware, applyRateLimitHeaders } from './middleware/rateLimit';
import { securityMiddleware, contentTypeEnforcement } from './middleware/security';

export const logger = pino({ level: config.logLevel });

export const circuitBreakers = new Map<string, CircuitBreaker>([
  ['soroban', new CircuitBreaker('soroban')],
  ['moonpay', new CircuitBreaker('moonpay')],
  ['transak', new CircuitBreaker('transak')],
  ['cex', new CircuitBreaker('cex')],
]);

// Register webhook verifiers with provider secrets
registerWebhookVerifier('moonpay', moonpayVerifier, config.moonpay.secretKey);
registerWebhookVerifier('transak', transakVerifier, config.transak.webhookSecret);

// Seed legacy plain-string API keys from env so existing integrations keep working
if (config.apiKeys.length > 0) {
  seedLegacyKeys(config.apiKeys);
}

const app = express();

app.use(helmet());
app.use(cors());

// Response compression (gzip/brotli, threshold from config)
app.use(compressionMiddleware);

app.use(versionCompatibility);
app.use(rateLimitMiddleware);
app.use(applyRateLimitHeaders);

// Webhook routes need raw body for HMAC verification
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

app.use('/api/v1/quote', rbacAuth, quoteRouter);
app.use('/api/v2/quote', rbacAuth, quoteRouter);
app.use('/api/v1/fund', rbacAuth, fundingRouter);
app.use('/api/v2/fund', rbacAuth, fundingRouter);
app.use('/api/v1/status', rbacAuth, statusRouter);
app.use('/api/v2/status', rbacAuth, statusRouter);
app.use('/api/v1/offramp', rbacAuth, offrampRouter);
app.use('/api/v2/offramp', rbacAuth, offrampRouter);
app.use('/api/v1/cex', rbacAuth, cexRouter);
app.use('/api/v2/cex', rbacAuth, cexRouter);
app.use('/api/quote', rbacAuth, quoteRouter);
app.use('/api/fund', rbacAuth, fundingRouter);
app.use('/api/status', rbacAuth, statusRouter);
app.use('/api/offramp', rbacAuth, offrampRouter);
app.use('/api/cex', rbacAuth, cexRouter);

// Webhook endpoints — signature verified by middleware, no API key required
app.use('/api/webhook/moonpay', moonpayWebhookRouter);
app.use('/api/webhook/transak', transakWebhookRouter);

// Admin endpoints
app.use('/api/v1/webhooks', rbacAuth, webhookAdminRouter);
app.use('/api/v1/keys', rbacAuth, apiKeysRouter);

app.use(errorHandler);

if (process.env.NODE_ENV !== 'test') {
  app.listen(config.port, config.host, () => {
    logger.info({ port: config.port, rpcUrls: config.soroban.rpcUrls.length }, 'bridge api server started');
  });
}

export { app };
