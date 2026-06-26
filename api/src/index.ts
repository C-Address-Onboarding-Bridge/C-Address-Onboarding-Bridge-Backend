import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './config';
import { logger } from './logger';
import { fundingRouter } from './routes/funding';
import { quoteRouter } from './routes/quote';
import { statusRouter } from './routes/status';
import { offrampRouter } from './routes/offramp';
import { cexRouter } from './routes/cex';
import { moonpayWebhookRouter, transakWebhookRouter } from './routes/webhook';
import { webhookAdminRouter } from './routes/webhookAdmin';
import { apiKeysRouter } from './routes/apiKeys';
import { docsRouter } from './routes/docs';
import { rbacAuth, seedLegacyKeys } from './middleware/rbacAuth';
import { registerWebhookVerifier, moonpayVerifier, transakVerifier } from './middleware/webhookVerification';
import { compressionMiddleware } from './middleware/compression';
import { errorHandler } from './middleware/error';
import { CircuitBreaker } from './circuit-breaker';
import { versionCompatibility } from './middleware/versioning';
import { rateLimitMiddleware, applyRateLimitHeaders } from './middleware/rateLimit';
import { securityMiddleware, contentTypeEnforcement } from './middleware/security';
import { requestTracker } from './middleware/requestTracker';
import { loggingMiddleware } from './middleware/logging';
import { gracefulShutdown, registerSignalHandlers } from './shutdown';

export { logger } from './logger';

export const circuitBreakers = new Map<string, CircuitBreaker>([
  ['soroban', new CircuitBreaker('soroban')],
  ['moonpay', new CircuitBreaker('moonpay')],
  ['transak', new CircuitBreaker('transak')],
  ['cex', new CircuitBreaker('cex')],
]);

registerWebhookVerifier('moonpay', moonpayVerifier, config.moonpay.secretKey);
registerWebhookVerifier('transak', transakVerifier, config.transak.webhookSecret);

if (config.apiKeys.length > 0) {
  seedLegacyKeys(config.apiKeys);
}

const app = express();

app.set('logger', logger);

app.use(helmet());
app.use(cors());

app.use(compressionMiddleware);
app.use(versionCompatibility);
app.use(rateLimitMiddleware);
app.use(applyRateLimitHeaders);

// Health check registered BEFORE requestTracker so Kubernetes preStop hooks always reach it
app.get('/health', (_req, res) => {
  if (gracefulShutdown.shuttingDown) {
    res.status(503).json({ status: 'shutting_down', timestamp: Date.now(), circuits: {} });
    return;
  }
  const circuits: Record<string, string> = {};
  for (const [name, cb] of circuitBreakers) {
    circuits[name] = cb.getState();
  }
  res.json({ status: 'ok', timestamp: Date.now(), circuits });
});

// Reject new requests during shutdown and track active request count
app.use(requestTracker);

// PII-masking request/response logger
app.use(loggingMiddleware);

app.use('/api/webhook', express.text({ type: '*/*' }));
app.use('/api', express.json({ limit: '32kb' }));

app.use('/api', securityMiddleware);
app.use('/api/v1', contentTypeEnforcement);

app.get('/api/v1/deprecations', (_req, res) => {
  res.json({
    version: 'v1',
    deprecated: true,
    sunset: '2027-12-31',
    features: ['legacy quote endpoints', 'legacy funding routing', 'legacy status polling'],
  });
});

// OpenAPI spec + Swagger UI interactive docs
app.use('/api', docsRouter);

app.use('/api/v1/quote', rbacAuth, quoteRouter);
app.use('/api', telemetryRouter);
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

app.use('/api/webhook/moonpay', moonpayWebhookRouter);
app.use('/api/webhook/transak', transakWebhookRouter);

app.use('/api/v1/webhooks', rbacAuth, webhookAdminRouter);
app.use('/api/v1/keys', rbacAuth, apiKeysRouter);
app.use('/api/v1/transactions', rbacAuth, transactionsRouter);
app.use('/api/v1/admin', rbacAuth, adminRouter);

app.use(errorHandler);

if (process.env.NODE_ENV !== 'test') {
  const server = app.listen(config.port, config.host, () => {
    logger.info({ port: config.port, rpcUrls: config.soroban.rpcUrls.length }, 'bridge api server started');
  });

  gracefulShutdown.attach(server, logger);

  if (config.jobs.enabled) {
    import('./jobs/queue').then(async ({ getAllQueues, scheduleRecurringJobs, closeQueues }) => {
      const { createBullBoard } = await import('@bull-board/api');
      const { BullMQAdapter } = await import('@bull-board/api/bullMQAdapter');
      const { ExpressAdapter } = await import('@bull-board/express');

      const serverAdapter = new ExpressAdapter();
      serverAdapter.setBasePath('/api/jobs');
      createBullBoard({ queues: getAllQueues().map((q) => new BullMQAdapter(q)), serverAdapter });
      app.use('/api/jobs', serverAdapter.getRouter());

      await scheduleRecurringJobs();
      logger.info('background job queues ready');

      registerSignalHandlers(async () => {
        await closeQueues();
        logger.info('job queues closed');
      });
    }).catch((err: Error) => {
      logger.error({ err }, 'failed to initialize job queues');
      registerSignalHandlers(async () => {});
    });
  } else {
    registerSignalHandlers(async () => {});
  }
}

export { app };
