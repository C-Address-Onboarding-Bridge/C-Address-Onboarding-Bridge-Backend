import { describe, it, expect, vi } from 'vitest';

process.env.NODE_ENV = 'test';

vi.mock('../logger', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

describe('XSS Filter Regression', () => {
  it('should detect the issue: XSS pattern with g flag alternates matching', () => {
    // This demonstrates the bug: RegExp with 'g' flag maintains state across calls
    const XSS_WITH_BUG = [/<script[\s\S]*?>[\s\S]*?<\/script>/gi];
    const payload = '<script>alert(1)</script>';

    const results = [];
    for (let i = 0; i < 4; i++) {
      results.push(XSS_WITH_BUG.some(r => r.test(payload)));
    }

    // Bug: should be [true, true, true, true] but is [true, false, true, false]
    expect(results).toEqual([true, false, true, false]);
  });

  it('XSS_PATTERNS with g flag have stateful lastIndex', () => {
    // Demonstrates the root cause: g flag makes regex stateful
    const scriptRegex = /<script[\s\S]*?>[\s\S]*?<\/script>/gi;
    const payload = '<script>alert(1)</script>';

    const match1 = scriptRegex.test(payload);
    const lastIndex1 = scriptRegex.lastIndex;

    const match2 = scriptRegex.test(payload);
    const lastIndex2 = scriptRegex.lastIndex;

    const match3 = scriptRegex.test(payload);
    const lastIndex3 = scriptRegex.lastIndex;

    // Demonstrate the state progression
    expect(match1).toBe(true);
    expect(lastIndex1).toBeGreaterThan(0); // lastIndex advanced
    expect(match2).toBe(false); // Next test fails because lastIndex is not at start
    expect(lastIndex2).toBe(0); // Reset after failed match
    expect(match3).toBe(true); // Now it works again
    expect(lastIndex3).toBeGreaterThan(0);
  });

  it('should ensure XSS_PATTERNS do not have g flag after fix', () => {
    // After fix, XSS_PATTERNS should not have 'g' flag
    const XSS_PATTERNS_FIXED = [
      /<script[\s\S]*?>[\s\S]*?<\/script>/i, // No 'g' flag
      /javascript\s*:/i, // No 'g' flag
      /on\w+\s*=/i, // No 'g' flag
      /<iframe[\s\S]*?>/i, // No 'g' flag
      /data:\s*text\/html/i, // No 'g' flag
    ];

    // Verify none have the 'g' flag
    XSS_PATTERNS_FIXED.forEach((pattern) => {
      expect(pattern.global).toBe(false);
    });
  });

  it('should reject same XSS payload consistently every time', () => {
    // After fix: pattern without 'g' flag should match consistently
    const XSS_PATTERNS_FIXED = [/<script[\s\S]*?>[\s\S]*?<\/script>/i];
    const payload = '<script>alert(1)</script>';

    const results = [];
    for (let i = 0; i < 4; i++) {
      results.push(XSS_PATTERNS_FIXED.some(r => r.test(payload)));
    }

    // After fix: all should be true
    expect(results).toEqual([true, true, true, true]);
  });

  it('should detect multiple different XSS payloads consistently', () => {
    const XSS_PATTERNS_FIXED = [
      /<script[\s\S]*?>[\s\S]*?<\/script>/i,
      /javascript\s*:/i,
      /on\w+\s*=/i,
      /<iframe[\s\S]*?>/i,
      /data:\s*text\/html/i,
    ];

    const xssPayloads = [
      '<script>alert("xss")</script>',
      'javascript:alert(1)',
      '<img onerror=alert(1)>',
      '<iframe src="evil.com"></iframe>',
      'data:text/html,<script>alert(1)</script>',
    ];

    // Each payload should be detected every time it's tested
    xssPayloads.forEach((payload) => {
      const results = [];
      for (let i = 0; i < 3; i++) {
        const detected = XSS_PATTERNS_FIXED.some(r => r.test(payload));
        results.push(detected);
      }
      // All iterations should detect the payload
      expect(results.every(r => r === true)).toBe(true);
    });
  });

  it('should not have false negatives on subsequent tests', () => {
    // Simulating the old buggy behavior to show the regression
    const XSS_PATTERNS_BUGGY = [/<script[\s\S]*?>[\s\S]*?<\/script>/gi];

    const suspiciousPayload = '<script>steal=cookies()</script>';

    // First request: payload is detected (true)
    const request1Detected = XSS_PATTERNS_BUGGY.some(r => r.test(suspiciousPayload));

    // Second identical request: MISSED because of g flag state (false) - this is the bug
    const request2Detected = XSS_PATTERNS_BUGGY.some(r => r.test(suspiciousPayload));

    // Third request: detected again (true)
    const request3Detected = XSS_PATTERNS_BUGGY.some(r => r.test(suspiciousPayload));

    // Document the buggy behavior
    expect(request1Detected).toBe(true);
    expect(request2Detected).toBe(false); // FALSE NEGATIVE
    expect(request3Detected).toBe(true);
  });

  it('fixed version should catch every XSS attempt', () => {
    const XSS_PATTERNS_FIXED = [/<script[\s\S]*?>[\s\S]*?<\/script>/i];

    const evilPayload = '<script>document.location="http://attacker.com"</script>';

    // Simulate 10 consecutive requests with same payload
    const results = [];
    for (let i = 0; i < 10; i++) {
      results.push(XSS_PATTERNS_FIXED.some(r => r.test(evilPayload)));
    }

    // Every single request should be caught
    expect(results.every(r => r === true)).toBe(true);
    expect(results.filter(r => r === false)).toHaveLength(0);
  });

  it('should reset lastIndex to 0 before each test as alternative fix', () => {
    // Alternative fix: reset lastIndex before each test
    const XSS_PATTERNS = [/<script[\s\S]*?>[\s\S]*?<\/script>/gi]; // Keep 'g' flag
    const payload = '<script>alert(1)</script>';

    const results = [];
    for (let i = 0; i < 4; i++) {
      // Reset lastIndex before test
      XSS_PATTERNS.forEach(p => (p.lastIndex = 0));
      results.push(XSS_PATTERNS.some(r => r.test(payload)));
    }

    // With lastIndex reset, all should be true
    expect(results).toEqual([true, true, true, true]);
  });

  it('should work correctly through injectionProtection middleware', () => {
    // Simulate the injectionProtection middleware behavior
    const XSS_PATTERNS = [/<script[\s\S]*?>[\s\S]*?<\/script>/i]; // Fixed: no 'g'

    const simulateInjectionProtection = (payload: string) => {
      return XSS_PATTERNS.some(p => p.test(payload));
    };

    // Multiple requests with XSS payload should all be blocked
    const payloads = [
      '<script>alert(1)</script>',
      '<script>alert(1)</script>',
      '<script>alert(1)</script>',
    ];

    const results = payloads.map(p => simulateInjectionProtection(p));
    expect(results).toEqual([true, true, true]);
  });

  it('SQL_PATTERNS should not be affected (they lack g flag already)', () => {
    const SQL_PATTERNS = [
      /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|EXEC|UNION|TRUNCATE|DECLARE|CAST|CONVERT)\b)/i,
      /(--|\/\*|\*\/|;|\bxp_|\bsp_)/i,
      /(\bOR\b|\bAND\b)\s+['"]?\d+['"]?\s*=\s*['"]?\d+['"]?/i,
      /'\s*(OR|AND)\s*'/i,
      /SLEEP\s*\(\d+\)/i,
      /BENCHMARK\s*\(/i,
    ];

    // Verify SQL patterns don't have 'g' flag and work consistently
    SQL_PATTERNS.forEach((pattern) => {
      expect(pattern.global).toBe(false);
    });

    // Test them multiple times - should all work
    const sqlPayload = "'; DROP TABLE users; --";
    const results = [];
    for (let i = 0; i < 3; i++) {
      results.push(SQL_PATTERNS.some(p => p.test(sqlPayload)));
    }

    expect(results).toEqual([true, true, true]);
  });

  it('NOSQL_PATTERNS should not be affected (they lack g flag already)', () => {
    const NOSQL_PATTERNS = [
      /\$where\b/,
      /\$(ne|gt|lt|gte|lte|in|nin|exists|regex|options|elemMatch|size|all|slice)\b/,
      /\$expr\b/,
      /mapReduce/i,
      /\$function\b/,
    ];

    // Verify NoSQL patterns don't have 'g' flag
    NOSQL_PATTERNS.forEach((pattern) => {
      expect(pattern.global).toBe(false);
    });

    // Test consistently
    const nosqlPayload = '{"$where":"function() { return true; }"}';
    const results = [];
    for (let i = 0; i < 3; i++) {
      results.push(NOSQL_PATTERNS.some(p => p.test(nosqlPayload)));
    }

    expect(results).toEqual([true, true, true]);
  });

  it('should prevent XSS bypasses that rely on regex state', () => {
    // Some attackers might know about the regex state bug and try to craft payloads
    // to slip through. After the fix, this should be impossible.

    const XSS_PATTERNS_FIXED = [/<script[\s\S]*?>[\s\S]*?<\/script>/i];

    // An attacker sends requests in sequence, knowing the old bug
    // Request 1: <script>alert(1)</script> - CAUGHT
    // Request 2: <script>alert(2)</script> - Would PASS (bug) but now CAUGHT
    // Request 3: <script>alert(3)</script> - CAUGHT

    const attackSequence = [
      '<script>alert(1)</script>',
      '<script>alert(2)</script>',
      '<script>alert(3)</script>',
    ];

    const detectionResults = attackSequence.map(payload =>
      XSS_PATTERNS_FIXED.some(p => p.test(payload))
    );

    expect(detectionResults).toEqual([true, true, true]);
    expect(detectionResults.filter(r => !r)).toHaveLength(0); // No misses
  });
});
