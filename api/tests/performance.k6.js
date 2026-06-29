import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.API_BASE_URL || 'http://localhost:3001';
const API_KEY = __ENV.API_KEY || 'benchmark-api-key';
const API_KEY_PREFIX = __ENV.API_KEY_PREFIX || '';
const TARGET_VUS = Number(__ENV.K6_TARGET_VUS || (API_KEY_PREFIX ? 20 : 1));
const STEADY_SECONDS = __ENV.K6_STEADY_SECONDS || '40s';
const SLEEP_SECONDS = Number(__ENV.K6_SLEEP_SECONDS || 3);

function apiKeyForVu() {
  return API_KEY_PREFIX ? `${API_KEY_PREFIX}${__VU}` : API_KEY;
}

export const options = {
  stages: [
    { duration: '20s', target: TARGET_VUS },
    { duration: STEADY_SECONDS, target: TARGET_VUS },
    { duration: '20s', target: 0 },
  ],
  thresholds: {
    http_req_duration: ['p(95)<500'],
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
  },
};

export default function () {
  const headers = { 'X-API-Key': apiKeyForVu(), Accept: 'application/json' };

  const healthRes = http.get(`${BASE_URL}/health/live`, { headers });
  check(healthRes, {
    'liveness status is 200': (response) => response.status === 200,
  });

  const quoteRes = http.get(
    `${BASE_URL}/api/v1/quote?sourceAsset=XLM&amount=1000000&targetAddress=CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW`,
    { headers },
  );
  check(quoteRes, {
    'quote status is 200': (response) => response.status === 200,
    'quote includes expected fields': (response) => {
      try {
        const body = response.json();
        return Boolean(body.estimatedFee && body.expectedReceive && body.feeBps);
      } catch {
        return false;
      }
    },
  });

  sleep(SLEEP_SECONDS);
}
