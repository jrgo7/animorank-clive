import { defineConfig } from 'vitest/config';
import { sveltekit } from '@sveltejs/kit/vite';
import { loadEnv } from 'vite';

/**
 * The CLive replay (`scripts/cliveReplay.replay.ts`): re-runs real past submissions
 * through the current prompts with the real provider. Not part of the test suite —
 * it costs money and reads local research logs. Run it with
 * `npx vitest run --config vitest.replay.config.ts`; `REPLAY_ONLY=<tag>`,
 * `REPLAY_DRY=1` and `REPLAY_OUT=<file>` steer it.
 */
export default defineConfig(({ mode }) => {
  Object.assign(process.env, loadEnv(mode, process.cwd(), ''));
  return {
    plugins: [sveltekit()],
    test: {
      include: ['scripts/**/*.replay.ts'],
      testTimeout: 60 * 60 * 1000,
      fileParallelism: false
    }
  };
});
