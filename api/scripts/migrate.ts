#!/usr/bin/env tsx
// Usage:
//   npx tsx scripts/migrate.ts             — apply all pending migrations
//   npx tsx scripts/migrate.ts rollback    — revert the last migration
//   npx tsx scripts/migrate.ts rollback 3  — revert the last 3 migrations
//   npx tsx scripts/migrate.ts status      — show applied / pending migrations
//   npx tsx scripts/migrate.ts seed        — insert dev seed data (non-production only)

import { migrationRunner } from '../src/migrations/runner';
import { migration001 } from '../src/migrations/001_initial_schema';

migrationRunner.register(migration001);

const [command = 'migrate', arg] = process.argv.slice(2);

async function main() {
  switch (command) {
    case 'migrate': {
      const { applied, skipped } = await migrationRunner.migrate();
      if (applied.length === 0) {
        console.log('[migrate] already up to date');
      } else {
        console.log(`[migrate] applied: ${applied.join(', ')}`);
      }
      if (skipped.length) {
        console.log(`[migrate] skipped (already applied): ${skipped.join(', ')}`);
      }
      break;
    }

    case 'rollback': {
      const steps = parseInt(arg || '1', 10);
      const reverted = await migrationRunner.rollback(steps);
      if (reverted.length === 0) {
        console.log('[migrate] nothing to roll back');
      } else {
        console.log(`[migrate] rolled back: ${reverted.join(', ')}`);
      }
      break;
    }

    case 'status': {
      const rows = migrationRunner.status();
      console.log('\nMigration Status:');
      console.log('─'.repeat(50));
      for (const row of rows) {
        const marker = row.status === 'applied' ? '✓' : '○';
        console.log(`${marker}  [${row.version}] ${row.name}  (${row.status})`);
      }
      console.log('─'.repeat(50) + '\n');
      break;
    }

    case 'seed': {
      const { runSeed } = await import('../src/migrations/seed');
      if (typeof runSeed === 'function') await runSeed();
      break;
    }

    default:
      console.error(`[migrate] unknown command: ${command}`);
      console.error('usage: migrate [migrate|rollback|status|seed] [steps]');
      process.exit(1);
  }
}

main().catch((err) => {
  console.error('[migrate] fatal:', err);
  process.exit(1);
});
