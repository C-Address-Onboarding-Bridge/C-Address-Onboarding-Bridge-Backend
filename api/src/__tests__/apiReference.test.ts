import { describe, expect, it } from 'vitest';
import { openApiSpec } from '../openapi/spec';
import { assertApiReferenceFilesCurrent } from '../scripts/generate-api-reference';

type PostmanItem = {
  request?: unknown;
  response?: unknown[];
  item?: PostmanItem[];
};

function flattenItems(items: PostmanItem[]): PostmanItem[] {
  return items.flatMap((item) => (item.item ? flattenItems(item.item) : [item]));
}

describe('API reference package', () => {
  it('checked-in Postman and OpenAPI files are generated from code', () => {
    const staleFiles = assertApiReferenceFilesCurrent();
    expect(staleFiles, `Run npm run api-reference:generate --workspace api. Stale files: ${staleFiles.join(', ')}`).toEqual([]);
  });

  it('Postman collection has a request and response examples for every OpenAPI operation', async () => {
    const collection = await import('../../../docs/api-reference/c-address-bridge.postman_collection.json');
    const items = flattenItems(collection.default.item as PostmanItem[]);
    const operationCount = Object.values(openApiSpec.paths ?? {}).reduce(
      (count, pathItem) => count + Object.keys(pathItem as Record<string, unknown>).length,
      0,
    );

    expect(items).toHaveLength(operationCount);
    for (const item of items) {
      expect(item.request).toBeDefined();
      expect(item.response?.length).toBeGreaterThan(0);
    }
  });
});
