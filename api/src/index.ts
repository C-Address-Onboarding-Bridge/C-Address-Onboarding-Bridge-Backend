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
import { metricsRouter } from './routes/metrics';
import { telemetryRouter } from './routes/telemetry';
import { transactionsRouter } from './routes/transactions';
import { adminRouter } from './routes/admin';
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
import { isRedisEnabled, getCacheMetrics } from './services/cache';
import { getHealthStatus } from './services/health';
import { updateCircuitBreakerMetrics, activeRequestsGauge, httpRequestCounter, httpRequestDuration } from './services/metrics';
import { createWebSocketServer, handleUpgrade } from './services/websocket';

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

// Prometheus instrumentation middleware
app.use((req, res, next) => {
  const start = Date.now();
  activeRequestsGauge.inc();
  res.on('finish', () => {
    activeRequestsGauge.dec();
    const route = req.route?.path ?? req.path;
    const labels = { method: req.method, path: route, status: String(res.statusCode) };
    httpRequestCounter.inc(labels);
    httpRequestDuration.observe(labels, (Date.now() - start) / 1000);
    updateCircuitBreakerMetrics(circuitBreakers);
  });
  next();
});

// Health check registered BEFORE requestTracker so Kubernetes preStop hooks always reach it
app.get('/health', async (_req, res) => {
  if (gracefulShutdown.shuttingDown) {
    res.status(503).json({ status: 'shutting_down', timestamp: Date.now() });
    return;
  }

  const circuits: Record<string, string> = {};
  for (const [name, cb] of circuitBreakers) {
    circuits[name] = cb.getState();
  }

  const health = await getHealthStatus();
  const statusCode = health.status === 'unhealthy' ? 503 : health.status === 'degraded' ? 207 : 200;

  res.status(statusCode).json({
    ...health,
    circuits,
    cache: { redis: isRedisEnabled(), metrics: getCacheMetrics() },
  });
});

// Kubernetes readiness probe — fails if any critical dependency is down
app.get('/health/ready', async (_req, res) => {
  if (gracefulShutdown.shuttingDown) {
    res.status(503).json({ ready: false, reason: 'shutting_down' });
    return;
  }
  const health = await getHealthStatus();
  const ready = health.status !== 'unhealthy';
  res.status(ready ? 200 : 503).json({ ready, status: health.status });
});

// Kubernetes liveness probe — always 200 unless process is broken
app.get('/health/live', (_req, res) => {
  res.json({ alive: true, timestamp: Date.now() });
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

// Prometheus metrics — internal only, protected by RBAC
app.use('/metrics', rbacAuth, metricsRouter);

app.use(errorHandler);

if (process.env.NODE_ENV !== 'test') {
  const wss = createWebSocketServer();

  const server = app.listen(config.port, config.host, () => {
    logger.info({ port: config.port, rpcUrls: config.soroban.rpcUrls.length }, 'bridge api server started');
  });

  // WebSocket upgrade at /ws
  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url ?? '/', `http://${req.headers.host}`);
    if (pathname === '/ws') {
      handleUpgrade(wss, req, socket as import('net').Socket, head);
    } else {
      socket.destroy();
    }
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
