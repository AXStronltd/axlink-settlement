import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      // src/services/ was removed when the code moved to core/ and providers/.
      // Pointing coverage at it meant test:coverage measured a directory that
      // does not exist and reported on nothing.
      include: ['src/core/**/*.ts', 'src/providers/**/*.ts', 'src/routes/**/*.ts'],
      // Raw partner API clients are thin HTTP wrappers with no branching worth
      // covering; their adapters and the code that calls them are included.
      exclude: ['src/providers/live/fireblocks.ts', 'src/providers/live/b2binpay.ts'],
    },
    testTimeout: 15_000,
  },
});
