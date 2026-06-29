import fs from 'fs';
import path from 'path';

export interface Migration {
  version: string;
  name: string;
  up: () => Promise<void>;
  down: () => Promise<void>;
}

interface MigrationState {
  applied: Array<{ version: string; name: string; appliedAt: number }>;
}

export class MigrationRunner {
  private migrations: Migration[] = [];
  private stateFile: string;

  constructor(stateFile?: string) {
    this.stateFile = stateFile ?? path.join(process.cwd(), '.migration-state.json');
  }

  private loadState(): MigrationState {
    try {
      return JSON.parse(fs.readFileSync(this.stateFile, 'utf-8'));
    } catch {
      return { applied: [] };
    }
  }

  private saveState(state: MigrationState): void {
    fs.writeFileSync(this.stateFile, JSON.stringify(state, null, 2));
  }

  register(migration: Migration): this {
    this.migrations.push(migration);
    this.migrations.sort((a, b) => a.version.localeCompare(b.version));
    return this;
  }

  private isApplied(version: string, state: MigrationState): boolean {
    return state.applied.some((m) => m.version === version);
  }

  async migrate(): Promise<{ applied: string[]; skipped: string[] }> {
    const state = this.loadState();
    const applied: string[] = [];
    const skipped: string[] = [];

    for (const migration of this.migrations) {
      if (this.isApplied(migration.version, state)) {
        skipped.push(migration.version);
        continue;
      }

      console.log(`[migration] running ${migration.version}: ${migration.name}`);
      await migration.up();

      state.applied.push({ version: migration.version, name: migration.name, appliedAt: Date.now() });
      this.saveState(state);
      applied.push(migration.version);
      console.log(`[migration] applied ${migration.version}`);
    }

    return { applied, skipped };
  }

  async rollback(steps = 1): Promise<string[]> {
    const state = this.loadState();
    const reverted: string[] = [];

    const toRollback = [...state.applied].reverse().slice(0, steps);

    for (const record of toRollback) {
      const migration = this.migrations.find((m) => m.version === record.version);
      if (!migration) {
        console.warn(`[migration] migration ${record.version} not found in registry — skipping rollback`);
        continue;
      }

      console.log(`[migration] rolling back ${migration.version}: ${migration.name}`);
      await migration.down();

      state.applied = state.applied.filter((m) => m.version !== record.version);
      this.saveState(state);
      reverted.push(migration.version);
      console.log(`[migration] rolled back ${migration.version}`);
    }

    return reverted;
  }

  status(): { version: string; name: string; status: 'applied' | 'pending' }[] {
    const state = this.loadState();
    return this.migrations.map((m) => ({
      version: m.version,
      name: m.name,
      status: this.isApplied(m.version, state) ? 'applied' : 'pending',
    }));
  }

  getAppliedVersions(): string[] {
    return this.loadState().applied.map((m) => m.version);
  }
}

export const migrationRunner = new MigrationRunner();
