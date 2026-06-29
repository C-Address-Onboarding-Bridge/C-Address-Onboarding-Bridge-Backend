#!/usr/bin/env node
/**
 * Builds SDK bundles with esbuild for browser consumers.
 * Generates minified ESM bundles and a metafile for size analysis.
 *
 * Usage:
 *   node scripts/build-bundle.mjs           # build only
 *   node scripts/build-bundle.mjs --analyze # build + print analysis
 */

import esbuild from 'esbuild';
import { gzipSync } from 'zlib';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const outDir = resolve(root, 'dist', 'bundle');
const analyze = process.argv.includes('--analyze');

mkdirSync(outDir, { recursive: true });

const sharedOptions = {
  bundle: true,
  minify: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2020',
  treeShaking: true,
  legalComments: 'none',
};

/** [entryPoint, outFile, label] */
const bundles = [
  ['src/core.ts',       'core.min.js',       'core'],
  ['src/index.ts',      'index.min.js',      'full'],
  ['src/offline.ts',    'offline.min.js',    'offline'],
  ['src/events.ts',     'events.min.js',     'events'],
  ['src/telemetry.ts',  'telemetry.min.js',  'telemetry'],
  ['src/pagination.ts', 'pagination.min.js', 'pagination'],
];

const results = [];
let fullMetafile = null;

for (const [entry, outFile, label] of bundles) {
  const needMeta = entry === 'src/index.ts';
  const result = await esbuild.build({
    ...sharedOptions,
    entryPoints: [resolve(root, entry)],
    outfile: resolve(outDir, outFile),
    metafile: needMeta,
  });

  if (result.errors.length > 0) {
    console.error(`esbuild errors in ${label}:`);
    result.errors.forEach((e) => console.error(' ', e.text));
    process.exit(1);
  }

  if (needMeta) fullMetafile = result.metafile;

  const bytes = readFileSync(resolve(outDir, outFile));
  const gz = gzipSync(bytes, { level: 9 });
  results.push({ label, raw: bytes.length, gz: gz.length });
}

if (fullMetafile) {
  writeFileSync(resolve(outDir, 'meta.json'), JSON.stringify(fullMetafile, null, 2));

  if (analyze) {
    const text = await esbuild.analyzeMetafile(fullMetafile, { verbose: false });
    console.log('\n=== esbuild bundle analysis (full) ===');
    console.log(text);
  }
}

console.log('\nBundle sizes:');
console.log('─'.repeat(52));
console.log('  Module        │  Raw (KB)  │  Gzip (KB)');
console.log('─'.repeat(52));
for (const { label, raw, gz } of results) {
  const rawKb = (raw / 1024).toFixed(2).padStart(9);
  const gzKb  = (gz  / 1024).toFixed(2).padStart(10);
  console.log(`  ${label.padEnd(14)}│${rawKb}  │${gzKb}`);
}
console.log('─'.repeat(52));
console.log('\nAnalysis report: dist/bundle/meta.json');
console.log('View at: https://esbuild.github.io/analyze/');
