<script lang="ts">
  import type { User } from '@auth/sveltekit';
  import WorkspaceToolbar, { type ToolbarLink } from '$lib/components/layout/WorkspaceToolbar.svelte';
  import { problemHref, problemSetHref } from '$lib/navigation';
  import type { ProblemLink } from '$lib/problem';
  import type { SolveWindowContext } from './context.svelte';

  let {
    context,
    user,
    neighbors
  }: {
    context: SolveWindowContext;
    user: User;
    /** The problems either side of this one in its set; `null` at either end. */
    neighbors: { previous: ProblemLink | null; next: ProblemLink | null };
  } = $props();

  /** Stepping lands the student in the sibling problem's own solve view. */
  const toStep = (problem: ProblemLink | null): ToolbarLink | null =>
    problem && { href: problemHref(problem.id), name: problem.name };

  const steps = $derived({
    previous: toStep(neighbors.previous),
    next: toStep(neighbors.next)
  });
</script>

<WorkspaceToolbar
  {user}
  backHref={problemSetHref(context.problem.problem_set_id)}
  neighbors={steps}
>
  <!-- Run and Submit live on the code editor's own bar, where an editor's run
       button usually is (a round 6 participant found them hard to place up here). -->
</WorkspaceToolbar>
