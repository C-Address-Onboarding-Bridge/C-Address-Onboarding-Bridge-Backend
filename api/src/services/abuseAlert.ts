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
  throw new Error('Not implemented: sendAbuseAlert');
}
