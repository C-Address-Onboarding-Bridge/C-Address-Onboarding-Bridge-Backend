import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
  },
  resolve: {
    alias: {
      // Resolve the sibling workspace package from its TS source so tests
      // don't depend on `sdk` having a prior `dist` build available.
      '@c-address-bridge/sdk': fileURLToPath(new URL('../sdk/src/index.ts', import.meta.url)),
    },
  },
});
