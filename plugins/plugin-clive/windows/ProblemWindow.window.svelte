<script lang="ts">
  import type { SolveWindowContext } from '../../../src/routes/problem/[problem_id]/[session_id]/context.svelte';

  let { context = $bindable() }: { context: SolveWindowContext } = $props();
</script>
