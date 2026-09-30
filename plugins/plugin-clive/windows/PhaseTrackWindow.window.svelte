<script lang="ts">
  import Button from '$lib/components/ui/buttons/Button.svelte';
  import { cliveSessionFor } from './cliveSession.svelte';
  import { PHASES } from './phase';
  import type { SolveWindowContext } from '../../../src/routes/problem/[problem_id]/[session_id]/context.svelte';

  let { context }: { context: SolveWindowContext } = $props();

  let session = $derived.by(() => cliveSessionFor(context.practiceSession.id, context.editorState.code));

  let anyLocked = $derived(session.phases.some((p) => !p.unlocked));

  /**
   * Force-unlocks a phase and jumps to its tab, so `PhaseWindowContent` shows
   * the real form instead of its locked placeholder. A stand-in for real
   * navigation until phases can actually be passed (server.ts is still a
   * stub): remove once judging is wired up and the tiles above unlock for
   * real, through `session.pass`.
   */
  async function preview(i: number): Promise<void> {
    session.phases[i].unlocked = true;
    session.open(i);
    await context.openWindow(`clive:${PHASES[i].phase}`);
  }

  function statusText(i: number): string {
    const st = session.phases[i];
    if (st.passed) return 'Passed';
    if (!st.unlocked) return 'Locked';
    if (i === session.current) return 'In progress';
    if (st.advanced) return 'Moved on';
    return 'Open';
  }

  function open(i: number): void {
    session.open(i);
    context.openWindow(`clive:${PHASES[i].phase}`);
  }

  let anyPassed = $derived(session.phases.some((p) => p.passed));

  function tileClass(current: boolean, unlocked: boolean, clickable: boolean): string {
    const base = current
      ? 'border-primary bg-primary/10'
      : !unlocked
        ? 'border-dashed border-base-content/15'
        : 'border-base-content/10 bg-base-200';
    return `flex flex-col gap-0.5 rounded-box border px-3.5 py-2.5 text-left transition-colors ${base} ${
      clickable ? 'cursor-pointer hover:bg-base-100' : ''
    }`;
  }
</script>

{#snippet tile(i: number)}
  {@const st = session.phases[i]}
  {@const current = i === session.current}
  <span
    class="font-mono text-[11.5px] {current
      ? 'text-primary'
      : !st.unlocked
        ? 'text-base-content/30'
        : 'text-base-content/50'}"
  >
    Phase {i + 1}
  </span>
  <span class="font-display text-sm font-bold {!st.unlocked ? 'text-base-content/30' : ''}">{PHASES[i].label}</span>
  <span
    class="text-xs {st.passed
      ? 'font-medium text-success'
      : current
        ? 'text-primary'
        : st.advanced
          ? 'font-medium text-warning'
          : !st.unlocked
            ? 'text-base-content/30'
            : 'text-base-content/60'}"
  >
    {statusText(i)}
  </span>
{/snippet}

<div class="flex h-full flex-col gap-3 overflow-y-auto p-4">
  <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
    {#each PHASES as p, i (p.phase)}
      {@const st = session.phases[i]}
      {@const current = i === session.current}
      {@const clickable = st.unlocked && !current && !session.busy}
      {#if clickable}
        <button
          type="button"
          class={tileClass(current, st.unlocked, true)}
          onclick={() => open(i)}
        >
          {@render tile(i)}
        </button>
      {:else}
        <div class={tileClass(current, st.unlocked, false)}>
          {@render tile(i)}
        </div>
      {/if}
    {/each}
  </div>
  {#if anyPassed}
    <p class="text-xs text-base-content/60">
      Passed phases stay open. Click one to reread or change it. Changes carry into later phases and never lock you out.
    </p>
  {/if}
  {#if anyLocked}
    <div class="flex flex-col gap-1.5 border-t border-base-content/10 pt-3">
      <span class="text-xs text-base-content/50">
        Preview (skips the phase gates — for checking the UI before judging is wired up):
      </span>
      <div class="flex flex-wrap gap-1.5">
        {#each PHASES as p, i (p.phase)}
          {#if i > 0}
            <Button
              class="btn-ghost btn-xs"
              type="button"
              onclick={() => preview(i)}>{p.label}</Button
            >
          {/if}
        {/each}
      </div>
    </div>
  {/if}
</div>
