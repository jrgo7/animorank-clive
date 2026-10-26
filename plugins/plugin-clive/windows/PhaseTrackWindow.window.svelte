<script lang="ts">
  import Button from '$lib/components/ui/buttons/Button.svelte';
  import { cliveSessionFor } from './cliveSession.svelte';
  import { PHASES } from './phase';
  import { showPhaseWindows } from './phaseWindows';
  import TutorialDialog from './TutorialDialog.svelte';
  import OverrideDialog from './OverrideDialog.svelte';
  import { CLIVE_EVENT } from './telemetry';
  import type { SolveWindowContext } from '../../../src/routes/problem/[problem_id]/[session_id]/context.svelte';

  let { context }: { context: SolveWindowContext } = $props();

  let session = $derived(cliveSessionFor(context));

  let anyPassed = $derived(session.phases.some((p) => p.passed));

  /**
   * CLive owns the solve page: switching phase moves the editor with it. The same
   * arrangement is set by the page hook when the page loads (see
   * `phaseWindows.ts`), which is what makes it stick even for a window built
   * before the page bound its window functions; this is the reactive half.
   */
  $effect(() => {
    showPhaseWindows(context, PHASES[session.current]?.phase ?? '');
  });

  let tutorialOpen = $state(false);
  let tutorialOffered = false;

  /**
   * A short walkthrough on a first visit, skippable from any card and reopened
   * from "How this works". Remembered on the practice session, so it is offered
   * once per sitting.
   */
  $effect(() => {
    if (tutorialOffered || session.tutorialSeen) return;
    tutorialOffered = true;
    tutorialOpen = true;
  });

  function closeTutorial(): void {
    tutorialOpen = false;
    session.tutorialSeen = true;
    session.persist();
  }

  let loadRecorded = false;

  /** One entry per page load: the solve page opened, whether CLive work was found, and the phase it resumed in. */
  $effect(() => {
    if (loadRecorded) return;
    loadRecorded = true;
    context.telemetry.record(CLIVE_EVENT.problemLoad, {
      problem: context.problem.id,
      restored: session.restored,
      phase: PHASES[session.current]?.phase ?? null
    });
  });

  function statusText(i: number): string {
    const st = session.phases[i];
    if (st.passed) return 'Passed';
    if (!st.unlocked) return 'Locked';
    if (i === session.current) return 'In progress';
    if (st.advanced) return 'Moved on';
    return 'Open';
  }

  function override(reason: string): void {
    const from = session.current;
    session.overrideOpen = false;
    session.moveOn(from, reason);
    const next = PHASES[session.current];
    if (session.current !== from && next) context.openWindow(`clive:${next.phase}`);
  }

  function open(i: number): void {
    session.open(i);
    context.telemetry.record(CLIVE_EVENT.phaseOpen, { phase: PHASES[i].phase, via: 'track' });
    context.openWindow(`clive:${PHASES[i].phase}`);
  }

  function tileClass(current: boolean, unlocked: boolean, clickable: boolean): string {
    const base = current
      ? 'border-primary bg-primary/10'
      : !unlocked
        ? 'border-dashed border-base-content/15'
        : 'border-base-content/10 bg-base-200';
    return `flex min-w-0 items-baseline gap-2 overflow-hidden whitespace-nowrap rounded-box border px-3 py-1.5 text-left transition-colors ${base} ${
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
    {i + 1}
  </span>
  <span class="font-display text-sm font-bold {!st.unlocked ? 'text-base-content/30' : ''}">{PHASES[i].label}</span>
  <!-- One line whatever the column's width: the strip is pinned to one row of tiles. -->
  <span
    title={statusText(i)}
    class="min-w-0 truncate text-xs {st.passed
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

<div class="flex h-full flex-col gap-1.5 overflow-y-auto px-3 py-2">
  <div class="flex items-center justify-between gap-3">
    <span class="flex items-center gap-2 font-mono text-[11.5px] text-base-content/50">
      CLive
      {#if session.logging && !session.logging.ok}
        <span
          class="badge badge-error badge-sm font-bold"
          title={session.logging.reason}>NOT LOGGING</span
        >
      {/if}
    </span>
    <span class="flex items-center gap-3">
      {#if anyPassed}
        <span class="hidden text-xs text-base-content/50 md:inline"
          >Passed phases stay open: click one to reread or change it.</span
        >
      {/if}
      <Button
        class="btn-ghost btn-xs"
        type="button"
        onclick={() => (tutorialOpen = true)}>How this works</Button
      >
    </span>
  </div>
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

  {#if session.overrideOpen && PHASES[session.current + 1] && !session.phases[session.current].passed}
    <OverrideDialog
      from={PHASES[session.current].label}
      to={PHASES[session.current + 1].label}
      onconfirm={override}
      oncancel={() => (session.overrideOpen = false)}
    />
  {/if}
  {#if tutorialOpen}
    <TutorialDialog onclose={closeTutorial} />
  {/if}
</div>
