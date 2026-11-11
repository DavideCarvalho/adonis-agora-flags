import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * Integration suite: a real Postgres (testcontainers) for the SQL the Lucid store, the db transport,
 * the relay and the analytics backend emit. Split from `vitest.config.ts` so `pnpm test` stays fast
 * and runs without Docker.
 */
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    environment: 'node',
    globals: false,
    include: ['test/integration/**/*.{spec,test}.ts'],
    globalSetup: ['test/integration/global_setup.ts'],
    pool: 'forks',
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
