#!/usr/bin/env node
// check-expand-only-migrations.mjs — enforce expand/contract migrations (#1099).
//
// Deploys run `npm run migrate` while the *old* blue/green color is still
// serving traffic, so every migration's `up()` must be backwards compatible
// with the previous release ("expand" only: CREATE, ADD COLUMN, new indexes,
// nullable columns, backfills).
//
// Destructive statements in `up()` (DROP TABLE/COLUMN, RENAME, column type
// changes, SET NOT NULL, TRUNCATE) break the old color mid-deploy. They belong
// in a separate "contract" migration shipped one release later, once nothing
// running still uses the old shape. Mark such a file with the comment
//   // migration-phase: contract
// to acknowledge that; this check then lets it through.
//
// `down()` is not checked: rollbacks are expected to drop what `up()` added.
//
// Usage: node scripts/check-expand-only-migrations.mjs [migrations-dir]

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const dir = process.argv[2] ?? 'api/src/migrations';
const DESTRUCTIVE = [
  /\bDROP\s+TABLE\b/i,
  /\bDROP\s+COLUMN\b/i,
  /\bRENAME\s+(?:COLUMN\s+|TO\s+)/i,
  /\bALTER\s+COLUMN\s+[\w"]+\s+(?:SET\s+DATA\s+)?TYPE\b/i,
  /\bSET\s+NOT\s+NULL\b/i,
  /\bTRUNCATE\b/i,
];

function upBody(source) {
  const start = source.search(/\basync\s+up\s*\(/);
  if (start === -1) return '';
  const rest = source.slice(start);
  const end = rest.search(/\basync\s+down\s*\(/);
  return end === -1 ? rest : rest.slice(0, end);
}

const files = readdirSync(dir).filter((f) => /^\d+_.+\.(ts|js|sql)$/.test(f)).sort();
const violations = [];
for (const file of files) {
  const source = readFileSync(path.join(dir, file), 'utf8');
  if (/\/\/\s*migration-phase:\s*contract\b/.test(source)) continue;
  const body = file.endsWith('.sql') ? source : upBody(source);
  body.split('\n').forEach((line) => {
    if (/^\s*(--|\/\/|\*)/.test(line)) return;
    if (DESTRUCTIVE.some((re) => re.test(line))) violations.push(`${file}: ${line.trim()}`);
  });
}

if (violations.length > 0) {
  console.error('Destructive statements in migration up() break the color still serving traffic during a blue/green deploy:');
  for (const v of violations) console.error(`  ${v}`);
  console.error('Split them into a later "contract" migration and mark it with `// migration-phase: contract`.');
  process.exit(1);
}
console.log(`expand-only check passed (${files.length} migrations).`);
