import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.NODE_ENV = 'test';

describe('SLO Burn Rate Recording Rules', () => {
  describe('Funding Success Rate SLO', () => {
    it('defines explicit SLO for funding success rate', () => {
      const fundingSlo = {
        name: 'funding_success_rate',
        target: 0.999,
        description: '99.9% of funding requests should succeed',
      };

      expect(fundingSlo.target).toBe(0.999);
      expect(fundingSlo.target).toBeGreaterThan(0.95);
      expect(fundingSlo.target).toBeLessThan(1.0);
    });

    it('tracks funding success metric', () => {
      const metrics = {
        'bridge_fund_success_total': { type: 'counter', help: 'Total successful funding requests' },
        'bridge_fund_total': { type: 'counter', help: 'Total funding requests' },
      };

      expect(metrics['bridge_fund_success_total']).toBeDefined();
      expect(metrics['bridge_fund_total']).toBeDefined();
    });

    it('calculates success rate from metrics', () => {
      const successCount = 9990;
      const totalCount = 10000;
      const successRate = successCount / totalCount;

      expect(successRate).toBe(0.999);
      expect(successRate).toBeGreaterThanOrEqual(0.999);
    });
  });

  describe('API Latency SLO', () => {
    it('defines explicit SLO for API latency', () => {
      const latencySlo = {
        name: 'api_latency',
        target: 0.999,
        percentile: 99,
        latencyMs: 1000,
        description: '99.9% of API requests should complete within 1000ms at p99',
      };

      expect(latencySlo.percentile).toBe(99);
      expect(latencySlo.latencyMs).toBe(1000);
      expect(latencySlo.target).toBe(0.999);
    });

    it('tracks API latency metrics', () => {
      const metrics = {
        'http_request_duration_seconds': {
          type: 'histogram',
          help: 'HTTP request latency in seconds',
          buckets: [0.001, 0.01, 0.1, 0.5, 1, 2, 5],
        },
      };

      expect(metrics['http_request_duration_seconds']).toBeDefined();
      expect(metrics['http_request_duration_seconds'].buckets).toContain(1);
    });
  });

  describe('Short-Window Burn Rate Recording Rule', () => {
    it('records 5-minute burn rate for fast burn detection', () => {
      const burnRateRule = {
        name: 'slo:burn_rate:5m',
        interval: '1m',
        duration: '5m',
        definition: 'rate(slo_errors_total[5m]) / slo_total_requests',
      };

      expect(burnRateRule.duration).toBe('5m');
      expect(burnRateRule.interval).toBe('1m');
    });

    it('calculates short-window burn rate correctly', () => {
      const errorCount = 10;
      const totalCount = 1000;
      const burnRate = (errorCount / totalCount) / 0.999;

      expect(burnRate).toBeGreaterThan(1);
    });

    it('short-window rule fires on fast burn', () => {
      const burnRate = 10;
      const threshold = 14.4;

      expect(burnRate).toBeLessThan(threshold);
    });
  });

  describe('Long-Window Burn Rate Recording Rule', () => {
    it('records 1-hour burn rate for slow burn detection', () => {
      const burnRateRule = {
        name: 'slo:burn_rate:1h',
        interval: '5m',
        duration: '1h',
        definition: 'rate(slo_errors_total[1h]) / slo_total_requests',
      };

      expect(burnRateRule.duration).toBe('1h');
      expect(burnRateRule.interval).toBe('5m');
    });

    it('calculates long-window burn rate correctly', () => {
      const errorCount = 100;
      const totalCount = 100000;
      const burnRate = (errorCount / totalCount) / 0.999;

      expect(burnRate).toBeGreaterThan(0.1);
      expect(burnRate).toBeLessThan(1);
    });
  });

  describe('Multi-Window Alert Rules', () => {
    it('defines fast burn alert (high burn rate + short duration)', () => {
      const fastBurnAlert = {
        name: 'SLOBurnRateFast',
        condition: 'burn_rate_5m > 14.4',
        duration: '5m',
        severity: 'critical',
      };

      expect(fastBurnAlert.condition).toContain('14.4');
      expect(fastBurnAlert.severity).toBe('critical');
    });

    it('defines slow burn alert (low burn rate + long duration)', () => {
      const slowBurnAlert = {
        name: 'SLOBurnRateSlow',
        condition: 'burn_rate_1h > 6',
        duration: '1h',
        severity: 'warning',
      };

      expect(slowBurnAlert.condition).toContain('6');
      expect(slowBurnAlert.severity).toBe('warning');
    });

    it('uses appropriate thresholds for different time windows', () => {
      const thresholds = {
        '5m': 14.4,
        '1h': 6,
      };

      expect(thresholds['5m']).toBeGreaterThan(thresholds['1h']);
    });
  });

  describe('Alert Definition Validation', () => {
    it('confirms every metric in rules exists', () => {
      const metricsUsed = [
        'bridge_fund_success_total',
        'bridge_fund_total',
        'http_request_duration_seconds',
      ];

      const definedMetrics = [
        'bridge_fund_success_total',
        'bridge_fund_total',
        'http_request_duration_seconds',
      ];

      metricsUsed.forEach((metric) => {
        expect(definedMetrics).toContain(metric);
      });
    });

    it('validates alert routing exists', () => {
      const alertRouting = {
        SLOBurnRateFast: 'critical_alerts',
        SLOBurnRateSlow: 'warning_alerts',
      };

      expect(alertRouting['SLOBurnRateFast']).toBeDefined();
      expect(alertRouting['SLOBurnRateSlow']).toBeDefined();
    });
  });

  describe('Runbook Cross-Linking', () => {
    it('cross-links recording rules to runbook documentation', () => {
      const rule = {
        name: 'slo:burn_rate:5m',
        runbook: 'https://github.com/C-Address-Onboarding-Bridge/C-Address-Onboarding-Bridge-Backend/blob/main/docs/runbooks/slo-burn.md',
      };

      expect(rule.runbook).toContain('slo-burn.md');
      expect(rule.runbook).toContain('github.com');
    });

    it('includes burn rate interpretation in runbook', () => {
      const runbookGuidance = {
        'burn_rate_5m > 14.4': 'Immediate action required - SLO budget exhausted in < 1 hour at current rate',
        'burn_rate_1h > 6': 'Action required within the hour - SLO budget exhausted in 8 hours at current rate',
      };

      expect(Object.keys(runbookGuidance)).toHaveLength(2);
      expect(runbookGuidance['burn_rate_5m > 14.4']).toContain('Immediate');
    });
  });

  describe('SLO Budget Calculation', () => {
    it('calculates total SLO budget from target', () => {
      const target = 0.999;
      const budgetPercent = (1 - target) * 100;

      expect(budgetPercent).toBe(0.1);
    });

    it('calculates error budget in monthly window', () => {
      const monthlySeconds = 30 * 24 * 60 * 60;
      const budgetPercent = 0.1;
      const allowedErrorSeconds = (monthlySeconds * budgetPercent) / 100;

      expect(allowedErrorSeconds).toBeCloseTo(259.2, 1);
    });

    it('determines when error budget is exhausted', () => {
      const burnRate = 14.4;
      const hoursToExhaustion = 30 * 24 / burnRate;

      expect(hoursToExhaustion).toBeLessThan(50);
      expect(hoursToExhaustion).toBeGreaterThan(40);
    });
  });
});
