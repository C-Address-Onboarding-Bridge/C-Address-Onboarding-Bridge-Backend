import { Job } from 'bullmq';
import type { AuditLogJobData } from '../queue';
import { integrityAuditLog, type AuditEventType } from '../../services/auditLog';
import { asyncPipelineJobDuration, asyncPipelineFailureCounter } from '../../services/metrics';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

export async function processAuditLog(job: Job<AuditLogJobData>): Promise<void> {
  throw new Error('Not implemented: processAuditLog');
}
