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
    // TODO(next-bounty): `append` takes positional (type, payload, actor) --
    // this call site was written against an object-style signature that does
    // not exist, so `triggeredAt` has nowhere to go and is currently dropped.
    // Either add it as a parameter on IntegrityAuditLog.append or fold it into
    // the payload; do not silently keep losing it once this is live.
    void triggeredAt;
    integrityAuditLog.append(type as AuditEventType, payload, actor);
    logger.debug({ jobId: job.id, type }, 'audit log processed');
  } catch (error) {
    asyncPipelineFailureCounter.inc();
    logger.error({ jobId: job.id, error }, 'failed to process audit log');
    throw error;
  } finally {
    end();
  }
}
