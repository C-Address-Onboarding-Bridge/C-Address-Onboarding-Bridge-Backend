import { Job } from 'bullmq';
import type { AuditLogJobData } from '../queue';
import { integrityAuditLog, type AuditEventType } from '../../services/auditLog';
import { asyncPipelineJobDuration, asyncPipelineFailureCounter } from '../../services/metrics';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

export async function processAuditLog(job: Job<AuditLogJobData>): Promise<void> {
  const end = asyncPipelineJobDuration.startTimer();
  try {
    const { type, payload, actor, triggeredAt } = job.data;
    integrityAuditLog.append({
      type: type as AuditEventType,
      payload,
      actor,
      triggeredAt,
    });
    logger.debug({ jobId: job.id, type }, 'audit log processed');
  } catch (error) {
    asyncPipelineFailureCounter.inc();
    logger.error({ jobId: job.id, error }, 'failed to process audit log');
    throw error;
  } finally {
    end();
  }
}
