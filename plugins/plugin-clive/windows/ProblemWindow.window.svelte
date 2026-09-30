<script lang="ts">
  import PhaseWindowContent from './PhaseWindowContent.svelte';
  import type { SolveWindowContext } from '../../../src/routes/problem/[problem_id]/[session_id]/context.svelte';

  // `phaseIndex` is fixed per wrapper file rather than taken as a prop: `Window`
  // types its mounted component as `Component<{ context: T }>` (see
  // `$lib/window/index.ts`), so a required extra prop here would fail that
  // type even though `options.props` does forward it at runtime.
  let { context }: { context: SolveWindowContext } = $props();
</script>

<PhaseWindowContent
  {context}
  phaseIndex={0}
/>
