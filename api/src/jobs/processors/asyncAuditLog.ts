import { Job } from 'bullmq';
import type { AuditLogJobData } from '../queue';
import { integrityAuditLog, type AuditEventType } from '../../services/auditLog';
import { asyncPipelineJobDuration, asyncPipelineFailureCounter } from '../../services/metrics';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

export async function processAuditLog(job: Job<AuditLogJobData>): Promise<void> {
  const end = asyncPipelineJobDuration.startTimer({ queue: 'async-critical', job: 'async-audit-log' });

  try {
    const { type, payload, actor } = job.data;
    integrityAuditLog.append(type as AuditEventType, payload, actor);
    logger.debug({ jobId: job.id, type, actor }, 'async audit log entry written');
  } catch (err) {
    asyncPipelineFailureCounter.inc({ queue: 'async-critical', job: 'async-audit-log' });
    logger.error({ jobId: job.id, err }, 'async audit log processor failed');
    throw err; // rethrow so BullMQ marks the job as failed and retries
  } finally {
    end();
  }
}
