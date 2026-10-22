import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));

// TypeScript matches export conditions in order and requires `types` first
// (#683). Full resolution is checked in CI with @arethetypeswrong/cli.
describe('package exports', () => {
  const root = pkg.exports['.'];

  it.each(['import', 'require'])('gives %s consumers their own types entry, listed first', (condition) => {
    const entry = root[condition];

    expect(typeof entry).toBe('object');
    expect(Object.keys(entry)[0]).toBe('types');
  });

  it('points ESM consumers at the ESM declarations', () => {
    expect(root.import.types).toBe('./dist/esm/index.d.ts');
    expect(root.require.types).toBe('./dist/index.d.ts');
  });
});
