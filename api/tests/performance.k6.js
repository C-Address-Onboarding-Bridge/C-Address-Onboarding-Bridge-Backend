import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '30s', target: 50 }, // simulate ramp-up of traffic from 1 to 50 users over 30s.
    { duration: '1m', target: 50 }, // stay at 50 users for 1 minute
    { duration: '30s', target: 0 }, // ramp-down to 0 users
  ],
  thresholds: {
    http_req_duration: ['p(95)<500'], // 95% of requests should be below 500ms
    http_req_failed: ['rate<0.01'], // http errors should be less than 1%
  },
};

export default function () {
  const BASE_URL = __ENV.API_BASE_URL || 'http://localhost:3000';
  
  const res = http.get(`${BASE_URL}/health`);
  check(res, {
    'status is 200': (r) => r.status === 200,
  });
  
  const addressRes = http.get(`${BASE_URL}/api/v1/addresses/GCABC1234567890`);
  check(addressRes, {
    'address endpoint status is 200 or 404': (r) => r.status === 200 || r.status === 404,
  });

  sleep(1);
}
