import { logger } from '../logger';

const ADMIN_ALERT_URL = process.env.ADMIN_ALERT_URL;

export interface AbuseAlertPayload {
  type: 'suspicious_activity' | 'ip_banned' | 'cost_limit_exceeded';
  ip: string;
  apiKeyId?: string;
  pattern?: string;
  details?: Record<string, unknown>;
}

export async function sendAbuseAlert(payload: AbuseAlertPayload): Promise<void> {
  logger.error(
    { alert: true, abuse: payload },
    `abuse detected: ${payload.type}`,
  );

  if (!ADMIN_ALERT_URL) return;

  try {
    await fetch(ADMIN_ALERT_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...payload,
        service: 'bridge-api',
        timestamp: new Date().toISOString(),
      }),
    });
  } catch (err) {
    logger.warn({ err, payload }, 'failed to deliver admin abuse alert');
  }
}
