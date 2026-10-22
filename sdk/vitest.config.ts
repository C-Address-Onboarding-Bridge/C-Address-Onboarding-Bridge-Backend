import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    // Keep the defaults (node_modules, dist, …) so a prior `npm run build`,
    // which emits compiled copies of these tests into `dist/`, cannot make the
    // suite run twice — and fail on stale compiled fixtures.
    exclude: [...configDefaults.exclude, '**/dist/**', 'tests/integration/**'],
  },
});
