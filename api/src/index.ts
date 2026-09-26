import { initTracing, shutdownTracing } from './tracing';
initTracing();

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
import { rbacAuth, requireScopes, seedLegacyKeys } from './middleware/rbacAuth';
import { registerWebhookVerifier, moonpayVerifier, transakVerifier } from './middleware/webhookVerification';
import { compressionMiddleware } from './middleware/compression';
import { errorHandler } from './middleware/error';
import { CircuitBreaker } from './circuit-breaker';
import { versionCompatibility } from './middleware/versioning';
import { ipRateLimitMiddleware, applyRateLimitHeaders, tierRateLimitMiddleware, telemetryRateLimit } from './middleware/rateLimit';
import { correlationMiddleware } from './middleware/correlation';
// import { setFeeRateBps } from './services/metrics'; // see TODO below
import { securityMiddleware, contentTypeEnforcement, suspiciousRateLimiting, xssErrorSanitizer } from './middleware/security';
import { requestTracker } from './middleware/requestTracker';
// import { loggingMiddleware } from './middleware/logging'; // see TODO below
import { gracefulShutdown, registerSignalHandlers } from './shutdown';
import { closePool } from './services/db';
import { isRedisEnabled, getCacheMetrics } from './services/cache';
import { getHealthStatus } from './services/health';
import { activeRequestsGauge, httpRequestCounter, httpRequestDuration } from './services/metrics';
import { createWebSocketServer, handleUpgrade } from './services/websocket';
import { cacheMetricsRouter } from './routes/cacheMetrics';

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

// TODO(next-bounty): setFeeRateBps() in services/metrics.ts is a
// `throw new Error('Not implemented')` stub, and this call runs at import time --
// so requiring this module threw, the server could not boot, and every test that
// imports the app failed to load. Restore once the metric is implemented.
// setFeeRateBps(config.soroban.feeBps);

const app = express();

app.set('logger', logger);

app.use(helmet());
app.use(
  cors({
    origin: config.corsOrigins.length > 0 ? config.corsOrigins : '*',
    methods: ['GET', 'POST', 'DELETE', 'PATCH'],
  })
);

app.use(compressionMiddleware);
app.use(versionCompatibility);
app.use(correlationMiddleware);
app.use(ipRateLimitMiddleware);
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
    // TODO(next-bounty): updateCircuitBreakerMetrics() is still a stub that throws.
    // It runs in every response's 'finish' handler, so it failed every request.
    // updateCircuitBreakerMetrics(circuitBreakers);
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
// TODO(next-bounty): loggingMiddleware (and the maskBody helper it relies on) is
// still a stub that throws. Registered globally, it turned every API request into
// a 500. Commented out until it is implemented -- note this means requests are
// NOT currently PII-masked in logs, which matters before anything goes live.
// app.use(loggingMiddleware);

app.use('/api/webhook', express.text({ type: '*/*' }));
app.use('/api', express.json({ limit: '32kb' }));

app.use('/api', suspiciousRateLimiting);
app.use('/api', securityMiddleware);
app.use('/api/v1', contentTypeEnforcement);
app.use('/api', tierRateLimitMiddleware);

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
app.use('/api/telemetry', telemetryRateLimit, telemetryRouter);
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

// Cache metrics endpoint – dedicated JSON view of cache health
app.use('/api/v1/cache/metrics', rbacAuth, cacheMetricsRouter);

// Prometheus metrics — internal only, protected by RBAC
app.use('/metrics', rbacAuth, metricsRouter);

// Bull Board queue dashboard — admin-only, must be mounted before the error pipeline
if (config.jobs.enabled) {
  const { createBullBoard } = require('@bull-board/api');
  const { BullMQAdapter } = require('@bull-board/api/bullMQAdapter');
  const { ExpressAdapter } = require('@bull-board/express');
  const { getAllQueues } = require('./services/queue');

  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath('/api/jobs');
  createBullBoard({ queues: getAllQueues().map((q: unknown) => new BullMQAdapter(q)), serverAdapter });
  app.use('/api/jobs', rbacAuth, requireScopes('admin:keys'), serverAdapter.getRouter());
}

app.use(xssErrorSanitizer);
app.use(errorHandler);

if (process.env.NODE_ENV !== 'test') {
  const server = app.listen(config.port, () => {
    logger.info({ port: config.port }, 'API server listening');
  });

  const wss = createWebSocketServer(server);
  server.on('upgrade', (req, socket, head) => handleUpgrade(wss, req, socket, head));

  registerSignalHandlers(async () => {
    await shutdownTracing();
    await closePool();
  });
}

export default app;
