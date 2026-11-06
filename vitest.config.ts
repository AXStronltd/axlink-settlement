import 'dotenv/config'; // tests read .env like the app does, so DATABASE_URL-gated suites run on a fresh checkout
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      // src/services/ was removed when the code moved to core/ and providers/.
      // Pointing coverage at it meant test:coverage measured a directory that
      // does not exist and reported on nothing.
      include: ['packages/**/*.ts', 'apps/api/src/**/*.ts'],
      // Raw partner API clients are thin HTTP wrappers with no branching worth
      // covering; their adapters and the code that calls them are included.
      exclude: ['packages/providers/custody/fireblocks/fireblocks.ts', 'packages/providers/liquidity/b2binpay/b2binpay.ts'],
    },
    testTimeout: 15_000,
  },
});
