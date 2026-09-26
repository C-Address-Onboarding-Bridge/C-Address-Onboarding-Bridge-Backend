import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

describe('package.json exports declaration conditions order (#683)', () => {
  it('places types condition first and provides separate import and require type entries', () => {
    const pkgPath = path.resolve(__dirname, '../package.json');
    const raw = fs.readFileSync(pkgPath, 'utf-8');
    const pkg = JSON.parse(raw);

    expect(pkg.exports).toBeDefined();
    expect(pkg.exports['.']).toBeDefined();

    const rootKeys = Object.keys(pkg.exports['.']);
    // TypeScript documentation requires 'types' condition to come first
    expect(rootKeys[0]).toBe('types');

    const typesEntry = pkg.exports['.']['types'];
    expect(typesEntry).toBeDefined();
    expect(typeof typesEntry).toBe('object');
    expect(typesEntry.import).toBe('./dist/esm/index.d.ts');
    expect(typesEntry.require).toBe('./dist/index.d.ts');

    expect(pkg.exports['.']['import']).toBe('./dist/esm/index.js');
    expect(pkg.exports['.']['require']).toBe('./dist/index.js');
  });
});
