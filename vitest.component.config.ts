import { defineConfig } from 'vitest/config';
import { sveltekit } from '@sveltejs/kit/vite';

/**
 * Component tests: the plugin's Svelte components, mounted for real.
 *
 * A separate config from `vite.config.ts` on purpose. The app's test transform is
 * the SSR one, where a component cannot be mounted (`mount` is unavailable and
 * runes are inert) — which is right for the app's node tests, but leaves the one
 * class of bug a pure-logic test cannot see: a `$state` write from inside a
 * `$derived` or a template expression, which only throws when a real component
 * tree evaluates it (`state_unsafe_mutation`).
 *
 * `resolve.conditions: ['browser']` picks the browser build of `svelte`, and
 * `happy-dom` supplies the document. Run it with `npm run test:component`.
 */
export default defineConfig({
  plugins: [sveltekit()],
  resolve: { conditions: ['browser'] },
  // The same list `vite.config.ts` gives the app build: without it Node's ESM loader is
  // handed `@gravity-ui/uikit`'s raw CSS imports (the problem statement renders through
  // the markdown editor), which it cannot load.
  ssr: {
    noExternal: ['@gravity-ui/uikit', '@gravity-ui/markdown-editor', '@gravity-ui/icons', 'react-use', 'monaco-editor']
  },
  test: {
    environment: 'happy-dom',
    include: ['plugins/**/*.mount.test.svelte.ts']
  }
});
