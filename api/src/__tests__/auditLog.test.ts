import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { IntegrityAuditLogService, integrityAuditLog, verifyAuditChain } from '../services/auditLog';
import { createApiKey } from '../middleware/rbacAuth';

process.env.NODE_ENV = 'test';
process.env.API_KEYS = 'test-api-key-123';
process.env.SOROBAN_RPC_URL = 'https://soroban-rpc.testnet.stellar.org';

let app: import('express').Express;

beforeEach(async () => {
  integrityAuditLog.clearForTest();
  const mod = await import('../index');
  app = mod.app;
});

describe('IntegrityAuditLogService', () => {
  it('chains each entry hash to the previous entry hash', () => {
    const service = new IntegrityAuditLogService({ checkpointInterval: 2 });
    const first = service.append('admin_operation', { operation: 'fee_change', feeBps: 20 }, 'admin-1');
    const second = service.append('fee_withdrawal', { amount: '10', recipient: 'treasury' }, 'admin-1');

    expect(first.previousHash).toMatch(/^0{64}$/);
    expect(second.previousHash).toBe(first.hash);
    expect(service.verify()).toEqual(expect.objectContaining({ valid: true, entryCount: 2, checkpointCount: 1 }));
  });

  it('detects tampering by recomputing the chain and comparing checkpoints', () => {
    const service = new IntegrityAuditLogService({ checkpointInterval: 1 });
    service.append('admin_operation', { operation: 'fee_change', feeBps: 20 }, 'admin-1');
    service.append('fee_withdrawal', { amount: '10', recipient: 'treasury' }, 'admin-1');

    service.tamperForTest(1, { operation: 'fee_change', feeBps: 9999 });

    const result = service.verify();
    expect(result.valid).toBe(false);
    expect(result.errors.map((error) => error.message)).toContain('entry hash mismatch');
    expect(result.errors.map((error) => error.message)).toContain('checkpoint hash does not match recomputed entry hash');
  });

  it('verifies exported entries against exported checkpoints', () => {
    const service = new IntegrityAuditLogService({ checkpointInterval: 1 });
    service.append('webhook_delivery', { payloadHash: 'abc', destination: 'https://example.com', result: 'success' }, 'api-key');

    const exported = service.exportJson();
    const result = verifyAuditChain(exported.entries, exported.checkpoints);

    expect(result.valid).toBe(true);
  });
});

describe('integrity audit admin API', () => {
  it('queries entries, exports auditor format, publishes checkpoints, and verifies integrity', async () => {
    integrityAuditLog.append('admin_operation', { operation: 'pause', reason: 'maintenance' }, 'admin-1');
    const { rawKey } = createApiKey({ name: 'audit-admin', createdBy: 'test', scopes: ['admin:keys'] });

    const list = await request(app)
      .get('/api/v1/admin/audit/integrity')
      .set('X-API-Key', rawKey);
    expect(list.status).toBe(200);
    expect(list.body.entries).toHaveLength(1);
    expect(list.body.entries[0]).toHaveProperty('previousHash');
    expect(list.body.entries[0]).toHaveProperty('hash');

    const checkpoint = await request(app)
      .post('/api/v1/admin/audit/integrity/checkpoints')
      .set('X-API-Key', rawKey)
      .send({});
    expect(checkpoint.status).toBe(201);
    expect(checkpoint.body.hash).toBe(list.body.entries[0].hash);

    const verify = await request(app)
      .get('/api/v1/admin/audit/integrity/verify')
      .set('X-API-Key', rawKey);
    expect(verify.status).toBe(200);
    expect(verify.body.valid).toBe(true);

    const exported = await request(app)
      .get('/api/v1/admin/audit/integrity/export')
      .set('X-API-Key', rawKey);
    expect(exported.status).toBe(200);
    expect(exported.body.format).toBe('c-address-bridge.audit.v1');
    expect(exported.body.retentionPolicy).toBe('7 years');
  });
});
