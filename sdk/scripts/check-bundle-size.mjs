#!/usr/bin/env node
/**
 * Bundle size budget check.
 * Reads dist/bundle/*.min.js, gzips each, and fails if any budget is exceeded.
 *
 * Budgets (gzipped):
 *   core        8 KB   — minimum viable SDK (BridgeClient + types)
 *   full index  15 KB  — everything including optional modules
 *   offline      5 KB  — OfflineQueue + OfflineBridgeClient
 *   events       4 KB  — BridgeEventEmitter
 *   telemetry    3 KB  — TelemetryClient
 *   pagination   2 KB  — PaginationHelper helpers
 */

import { readFileSync, existsSync } from 'fs';
import { gzipSync } from 'zlib';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(__dirname, '..', 'dist', 'bundle');

const BUDGETS_KB = {
  'core.min.js':       8,
  'index.min.js':     15,
  'offline.min.js':    5,
  'events.min.js':     4,
  'telemetry.min.js':  3,
  'pagination.min.js': 2,
};

let failed = false;

console.log('\nBundle size check:');
console.log('─'.repeat(60));
console.log('  File                │  Gzip (KB)  │  Budget (KB)  │  Status');
console.log('─'.repeat(60));

for (const [file, budgetKb] of Object.entries(BUDGETS_KB)) {
  const filePath = resolve(outDir, file);

  if (!existsSync(filePath)) {
    console.error(`  ${file}: NOT FOUND — run "npm run build:bundle" first`);
    failed = true;
    continue;
  }

  const raw = readFileSync(filePath);
  const gz = gzipSync(raw, { level: 9 });
  const gzKb = gz.length / 1024;
  const pass = gzKb <= budgetKb;
  const status = pass ? 'PASS' : `FAIL (+${(gzKb - budgetKb).toFixed(2)} KB over)`;

  const gzStr     = gzKb.toFixed(2).padStart(8);
  const budgetStr = budgetKb.toFixed(2).padStart(12);
  console.log(`  ${file.padEnd(20)}│${gzStr}     │${budgetStr}     │  ${status}`);

  if (!pass) failed = true;
}

console.log('─'.repeat(60));

if (failed) {
  console.error('\nBundle size budget EXCEEDED. Reduce bundle size or update budgets in scripts/check-bundle-size.mjs.\n');
  process.exit(1);
} else {
  console.log('\nAll bundles within budget.\n');
}
