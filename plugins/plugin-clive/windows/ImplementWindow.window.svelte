<script lang="ts">
  import Alert from '$lib/components/ui/alerts/Alert.svelte';
  import DesignPanel from './DesignPanel.svelte';
  import StuckButton from './StuckButton.svelte';
  import { isFunctionProblem } from './problemKind';
  import { cliveSessionFor, type CodeEscalation, type CodeFeedbackEntry } from './cliveSession.svelte';
  import { PHASES, type OutlineRow } from './phase';
  import { canEscalateCode } from './codeFeedback';
  import { CLIVE_EVENT } from './telemetry';
  import type { SolveWindowContext } from '../../../src/routes/problem/[problem_id]/[session_id]/context.svelte';

  // `phaseIndex` is fixed per window file rather than taken as a prop: `Window`
  // types its mounted component as `Component<{ context: T }>` (see
  // `$lib/window/index.ts`), so a required extra prop here would fail that type
  // even though `options.props` does forward it at runtime.
  let { context }: { context: SolveWindowContext } = $props();

  /**
   * Phase 4 of PCDIT, `implement`: the last phase, and the only one whose field
   * this window does not edit. The student writes the C in AnimoRank's own Code
   * Editor window, and Run and Submit there check it against the examples and the
   * hidden cases: a Submit that passes every test passes the phase. A failed Run or
   * Submit is answered here with a hint about the code, and "I'm stuck" under the
   * latest one brings a prompt for that run. Every word the student reads is here
   * rather than in `phase.ts`.
   */
  const config = PHASES[3];

  /** The one field this phase has: the code, which lives in the Code Editor window. */
  const codeField = config.artifactFields[0];

  /** Where the code actually lives, and what checks it. */
  const CODE_NOTE =
    'Edited in the Code Editor window. Run and Submit there check it against the examples and the hidden cases.';

  let session = $derived(cliveSessionFor(context));
  let functionProblem = $derived(isFunctionProblem(context.problem.extension_data));
  let phaseState = $derived(session.phases[3]);

  let elapsed = $state(0);
  $effect(() => {
    if (!session.busy) return;
    elapsed = 0;
    const id = setInterval(() => {
      elapsed = session.busySince ? Math.floor((Date.now() - session.busySince) / 1000) : 0;
    }, 1000);
    return () => clearInterval(id);
  });

  const THINK_NOTE_AFTER = 20;
  const THINK_LONG_AFTER = 60;
  const thinkNote = $derived(
    elapsed >= THINK_LONG_AFTER
      ? 'Taking longer than usual, but still working. Your work is saved.'
      : elapsed >= THINK_NOTE_AFTER
        ? "An answer can take up to a minute. Your work is saved, so please don't reload."
        : ''
  );

  const latestCode = $derived(phaseState.codeFeedback[0]);
  const olderCode = $derived(phaseState.codeFeedback.slice(1));
  /** "I'm stuck" goes under the latest reply only, while it is a hint nobody has pressed it for. */
  const offerEscalation = $derived(canEscalateCode(latestCode));
  const waiting = $derived(session.busy === 'escalate');

  /** The Design outline, as the Design phase holds it; blank before the student writes one. */
  const designSteps = $derived((session.phases[2].artifact.steps ?? []) as OutlineRow[]);

  /** A reply's lines; an empty one (or one recorded before 2026-11-28 and held back) gives what happened and where to look instead. */
  function linesOf(reply: CodeFeedbackEntry | CodeEscalation): string[] {
    if (reply.nudge.trim()) return reply.nudge.split('\n').filter((line) => line.trim());
    return [reply.summary ?? '', reply.focus ? `Look at ${reply.focus}.` : ''].filter((line) => line.trim());
  }

  function editDesign(): void {
    session.open(2);
    context.telemetry.record(CLIVE_EVENT.phaseOpen, { phase: PHASES[2].phase, via: 'design_panel' });
    context.openWindow(`clive:${PHASES[2].phase}`);
  }
</script>

{#snippet thinking()}
  <div
    class="flex items-start gap-2.5 rounded-box border border-base-content/10 bg-base-100 p-4 text-sm text-base-content/70"
    role="status"
  >
    <span class="mt-1.5 h-2 w-2 shrink-0 animate-pulse rounded-full bg-primary"></span>
    <div class="flex flex-col gap-0.5">
      <div class="font-medium text-base-content">
        CLive is thinking… <span class="ml-2 font-mono text-xs text-base-content/50">{elapsed}s</span>
      </div>
      <div>Looking for somewhere useful to point.</div>
      {#if thinkNote}<div class="text-xs">{thinkNote}</div>{/if}
    </div>
  </div>
{/snippet}

<div class="h-full min-w-0 overflow-y-auto">
  {#if !phaseState.unlocked}
    <div class="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <p class="max-w-[34ch] text-sm text-base-content/70">
        {config.label} opens once you have passed the phase before it.
      </p>
    </div>
  {:else}
    <div class="flex flex-col gap-5 p-5 pb-10">
      {#if session.error}
        <Alert class="alert-error"><span>{session.error}</span></Alert>
      {/if}

      {#if !session.hasApiKey}
        <Alert class="bg-base-200 text-sm text-base-content/70">
          <span>
            No API key is set on the server, so checking and help are unavailable. Your work is still saved as you type.
          </span>
        </Alert>
      {/if}

      <div class="flex items-baseline gap-2.5">
        <h2 class="font-display text-xl font-bold">{config.label}</h2>
        {#if phaseState.passed}<span class="font-mono text-xs font-normal text-base-content/50">Passed</span>{/if}
      </div>

      {#if phaseState.passed}
        <Alert class="bg-base-200 text-sm text-base-content/70">
          <span>You can keep improving this and submit again.</span>
        </Alert>
      {/if}

      <p class="max-w-[68ch] border-l-2 border-primary py-0.5 pl-4 text-sm leading-relaxed text-base-content/70">
        Now translate your plan into C, one step at a time. Refer to your design beside the code. Press Run to test it
        on the examples. Press Submit when it works for a final check against hidden test cases.
        {#if !functionProblem}
          Print only what the problem asks for, with no extra messages like "Enter a number:".
        {/if}
        Don't use AI tools like ChatGPT or external references.
      </p>

      <DesignPanel
        steps={designSteps}
        onedit={editDesign}
      />

      <!-- The code field has no editor of its own: the student writes it next door, in
           AnimoRank's Code Editor window, and this window only says so. -->
      <div class="flex flex-col gap-1.5">
        <span class="text-sm font-semibold">{codeField.label}</span>
        <span class="text-xs text-base-content/60"
          >{functionProblem ? 'Write the function the problem asks for.' : 'Write your whole program here.'}</span
        >

        <div
          class="rounded-lg border border-dashed border-base-content/20 bg-base-200 px-3 py-2.5 text-sm text-base-content/60"
        >
          {CODE_NOTE}
        </div>
      </div>

      {#if session.codeFeedbackBusy}
        <div
          class="flex items-center gap-2.5 rounded-box border border-base-content/10 bg-base-200 p-4 text-sm text-base-content/70"
          role="status"
        >
          <span class="h-2 w-2 shrink-0 animate-pulse rounded-full bg-primary"></span>
          <span>CLive is looking at your code…</span>
        </div>
      {:else if latestCode}
        <!-- The latest reply: its hint, the prompt "I'm stuck" brought under it, and the
             button while there is a hint to go further from. -->
        <div class="flex flex-col gap-2 rounded-box border-l-[3px] border-warning bg-base-200 p-5">
          <h3 class="font-display text-base font-bold text-warning">
            About your last {latestCode.runType === 'submit' ? 'Submit' : 'Run'}
          </h3>
          {#each linesOf(latestCode) as line, i (i)}
            <p
              class="max-w-[66ch] text-[15px] leading-relaxed"
              data-code-feedback-line
              data-nudge-level={latestCode.level ?? 'hint'}
            >
              {line}
            </p>
          {/each}
          {#if latestCode.escalation}
            <div
              class="flex max-w-[66ch] flex-col gap-1 border-l-2 border-base-content/20 pl-3 text-sm leading-relaxed"
              data-nudge-level="prompt"
            >
              {#each linesOf(latestCode.escalation) as line, i (i)}<p>{line}</p>{/each}
            </div>
          {/if}
          {#if waiting}{@render thinking()}{/if}
          {#if offerEscalation && !waiting}
            <StuckButton
              disabled={!!session.busy || !session.hasApiKey}
              onclick={() => session.escalateCode(context.problem.id)}
            />
          {/if}
          {#if olderCode.length}
            <details class="border-t border-base-content/10 pt-2.5">
              <summary class="cursor-pointer text-sm text-base-content/70">Earlier ({olderCode.length})</summary>
              <div class="mt-2 flex flex-col gap-2.5">
                {#each olderCode as entry, i (i)}
                  <div class="flex flex-col gap-1 text-sm leading-relaxed text-base-content/70">
                    <p class="whitespace-pre-line">{linesOf(entry).join('\n')}</p>
                    {#if entry.escalation}
                      <p class="border-l-2 border-base-content/20 pl-3 whitespace-pre-line">
                        {linesOf(entry.escalation).join('\n')}
                      </p>
                    {/if}
                  </div>
                {/each}
              </div>
            </details>
          {/if}
        </div>
      {/if}

      {#if phaseState.passed}
        <Alert class="alert-success">
          <span>Phase passed. That was the last one.</span>
        </Alert>
        <div class="py-8 text-center">
          <h2 class="mb-2 font-display text-2xl font-bold">Every phase passed</h2>
          <p class="mx-auto max-w-[46ch] text-base-content/70">
            A definition you wrote yourself, cases you worked by hand, a plan that accounts for them, and a program that
            carries it out.
          </p>
        </div>
      {/if}
    </div>
  {/if}
</div>
