import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { openApiSpec } from '../openapi/spec';

/**
 * Every route mounted in index.ts must have an OpenAPI entry (#690).
 *
 * Routes are read from source rather than from the live Express app so the
 * check does not depend on every route module's dependencies loading.
 * A router mounted under several prefixes (/api/v1, /api/v2, /api) is
 * covered when any one of its mount paths is documented.
 */

const SRC = join(__dirname, '..');
const METHODS = 'get|post|put|patch|delete';

function read(file: string): string {
  return readFileSync(join(SRC, file), 'utf8');
}

function toSpecPath(prefix: string, sub: string): string {
  const joined = sub === '/' ? prefix : `${prefix}${sub}`;
  return joined.replace(/:(\w+)/g, '{$1}');
}

function routesByVariable(source: string): Map<string, Array<{ method: string; path: string }>> {
  const routes = new Map<string, Array<{ method: string; path: string }>>();
  const re = new RegExp(`\\b(\\w+)\\.(${METHODS})\\(\\s*'([^']+)'`, 'g');
  for (const [, variable, method, path] of source.matchAll(re)) {
    if (!routes.has(variable)) routes.set(variable, []);
    routes.get(variable)!.push({ method, path });
  }
  return routes;
}

function mountedOperations(): Array<{ method: string; candidates: string[] }> {
  const index = read('index.ts');
  const operations: Array<{ method: string; candidates: string[] }> = [];

  // Routes registered directly on the app.
  for (const { method, path } of routesByVariable(index).get('app') ?? []) {
    operations.push({ method, candidates: [toSpecPath(path, '/')] });
  }

  // Router name -> source file.
  const routerFiles = new Map<string, string>();
  for (const [, names, file] of index.matchAll(/import \{([^}]+)\} from '\.\/routes\/(\w+)'/g)) {
    for (const name of names.split(',').map((n) => n.trim()).filter((n) => n.endsWith('Router'))) {
      routerFiles.set(name, `routes/${file}.ts`);
    }
  }

  // Router name -> every prefix it is mounted under.
  const prefixes = new Map<string, string[]>();
  for (const [, prefix, args] of index.matchAll(/app\.use\(\s*'([^']+)',([^;]*?)\);/g)) {
    const router = args.split(',').map((a) => a.trim()).pop()!;
    if (!routerFiles.has(router)) continue;
    prefixes.set(router, [...(prefixes.get(router) ?? []), prefix]);
  }

  for (const [router, mounts] of prefixes) {
    const byVariable = routesByVariable(read(routerFiles.get(router)!));
    // Some modules define routes on a local `router` and export it under another name.
    for (const { method, path } of byVariable.get(router) ?? byVariable.get('router') ?? []) {
      operations.push({ method, candidates: mounts.map((prefix) => toSpecPath(prefix, path)) });
    }
  }

  return operations;
}

describe('OpenAPI route coverage', () => {
  const paths = openApiSpec.paths as Record<string, Record<string, unknown>>;
  const operations = mountedOperations();

  it('finds the mounted routes', () => {
    // Guards against the source parsing silently matching nothing.
    expect(operations.length).toBeGreaterThan(40);
  });

  it('documents every mounted route', () => {
    const undocumented = operations
      .filter(({ method, candidates }) => !candidates.some((p) => paths[p]?.[method]))
      .map(({ method, candidates }) => `${method.toUpperCase()} ${candidates.join(' | ')}`);

    expect(undocumented).toEqual([]);
  });

  it('documents the WebSocket upgrade endpoint', () => {
    expect(paths['/ws']?.get).toBeDefined();
  });
});
