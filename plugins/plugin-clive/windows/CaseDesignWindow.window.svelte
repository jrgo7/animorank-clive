<script lang="ts">
  import PhaseWindowContent from './PhaseWindowContent.svelte';
  import type { SolveWindowContext } from '../../../src/routes/problem/[problem_id]/[session_id]/context.svelte';

  let { context }: { context: SolveWindowContext } = $props();
</script>

<PhaseWindowContent
  {context}
  phaseIndex={1}
/>
