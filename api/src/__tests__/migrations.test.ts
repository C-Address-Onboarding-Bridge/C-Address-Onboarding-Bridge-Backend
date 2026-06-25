import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MigrationRunner } from '../migrations/runner';
import type { Migration } from '../migrations/runner';

function makeTempStateFile(): string {
  return path.join(os.tmpdir(), `migration-state-${Date.now()}-${Math.random()}.json`);
}

function makeMigration(version: string, name: string): Migration & { upCalled: boolean; downCalled: boolean } {
  const m = {
    version,
    name,
    upCalled: false,
    downCalled: false,
    async up() { m.upCalled = true; },
    async down() { m.downCalled = true; },
  };
  return m;
}

describe('MigrationRunner', () => {
  let stateFile: string;

  beforeEach(() => {
    stateFile = makeTempStateFile();
  });

  afterEach(() => {
    try { fs.unlinkSync(stateFile); } catch { /* already gone */ }
  });

  describe('migrate', () => {
    it('applies pending migrations in version order', async () => {
      const runner = new MigrationRunner(stateFile);
      const m001 = makeMigration('001', 'create_users');
      const m002 = makeMigration('002', 'add_index');
      // register out-of-order to confirm sorting
      runner.register(m002).register(m001);

      const { applied, skipped } = await runner.migrate();
      expect(applied).toEqual(['001', '002']);
      expect(skipped).toHaveLength(0);
      expect(m001.upCalled).toBe(true);
      expect(m002.upCalled).toBe(true);
    });

    it('skips already applied migrations', async () => {
      const runner = new MigrationRunner(stateFile);
      const m001 = makeMigration('001', 'create_users');
      runner.register(m001);

      await runner.migrate();
      m001.upCalled = false;

      const { applied, skipped } = await runner.migrate();
      expect(applied).toHaveLength(0);
      expect(skipped).toEqual(['001']);
      expect(m001.upCalled).toBe(false);
    });

    it('reports already up-to-date when all migrations applied', async () => {
      const runner = new MigrationRunner(stateFile);
      const m001 = makeMigration('001', 'setup');
      runner.register(m001);
      await runner.migrate();

      const { applied } = await runner.migrate();
      expect(applied).toHaveLength(0);
    });
  });

  describe('rollback', () => {
    it('reverts the last applied migration by default', async () => {
      const runner = new MigrationRunner(stateFile);
      const m001 = makeMigration('001', 'create_users');
      const m002 = makeMigration('002', 'add_index');
      runner.register(m001).register(m002);

      await runner.migrate();
      const reverted = await runner.rollback();

      expect(reverted).toEqual(['002']);
      expect(m002.downCalled).toBe(true);
      expect(m001.downCalled).toBe(false);

      const statuses = runner.status();
      expect(statuses.find((s) => s.version === '002')?.status).toBe('pending');
      expect(statuses.find((s) => s.version === '001')?.status).toBe('applied');
    });

    it('reverts N migrations when steps > 1', async () => {
      const runner = new MigrationRunner(stateFile);
      const m001 = makeMigration('001', 'a');
      const m002 = makeMigration('002', 'b');
      const m003 = makeMigration('003', 'c');
      runner.register(m001).register(m002).register(m003);

      await runner.migrate();
      const reverted = await runner.rollback(2);

      expect(reverted).toEqual(['003', '002']);
      expect(m003.downCalled).toBe(true);
      expect(m002.downCalled).toBe(true);
      expect(m001.downCalled).toBe(false);
    });

    it('returns empty array when nothing to roll back', async () => {
      const runner = new MigrationRunner(stateFile);
      const reverted = await runner.rollback();
      expect(reverted).toHaveLength(0);
    });
  });

  describe('status', () => {
    it('lists all migrations with applied/pending status', async () => {
      const runner = new MigrationRunner(stateFile);
      const m001 = makeMigration('001', 'setup');
      const m002 = makeMigration('002', 'add_index');
      runner.register(m001).register(m002);

      await runner.migrate();
      const m003 = makeMigration('003', 'not_applied');
      runner.register(m003);

      const statuses = runner.status();
      expect(statuses).toHaveLength(3);
      expect(statuses.find((s) => s.version === '001')?.status).toBe('applied');
      expect(statuses.find((s) => s.version === '002')?.status).toBe('applied');
      expect(statuses.find((s) => s.version === '003')?.status).toBe('pending');
    });
  });

  describe('getAppliedVersions', () => {
    it('returns only applied versions', async () => {
      const runner = new MigrationRunner(stateFile);
      runner.register(makeMigration('001', 'a')).register(makeMigration('002', 'b'));
      await runner.migrate();
      runner.register(makeMigration('003', 'c'));

      const versions = runner.getAppliedVersions();
      expect(versions).toContain('001');
      expect(versions).toContain('002');
      expect(versions).not.toContain('003');
    });
  });
});
