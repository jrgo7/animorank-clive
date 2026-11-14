import { defineConfig } from 'vitest/config';
import { sveltekit } from '@sveltejs/kit/vite';
import { loadEnv } from 'vite';

/**
 * The larper (`scripts/larper/larper.larp.ts`): an LLM writes student answers of a named kind
 * and sends them through CLive with the real provider. Not part of the test suite —
 * it costs money and reads the local database. Run it with
 * `LARPER_PROBLEM=<id> npx vitest run --config vitest.larper.config.ts`;
 * `scripts/larper/README.md` lists what steers it.
 */
export default defineConfig(({ mode }) => {
  Object.assign(process.env, loadEnv(mode, process.cwd(), ''));
  return {
    plugins: [sveltekit()],
    test: {
      include: ['scripts/**/*.larp.ts'],
      testTimeout: 60 * 60 * 1000,
      fileParallelism: false
    }
  };
});
