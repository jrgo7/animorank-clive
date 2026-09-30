<script lang="ts">
  import { SvelteSet } from 'svelte/reactivity';
  import Textarea from '$lib/components/ui/textareas/Textarea.svelte';
  import Button from '$lib/components/ui/buttons/Button.svelte';
  import Alert from '$lib/components/ui/alerts/Alert.svelte';
  import LightbulbIcon from '@iconify-svelte/fa6-solid/lightbulb';
  import ArrowRightIcon from '@iconify-svelte/fa6-solid/arrow-right';
  import CaseRows from './CaseRows.svelte';
  import PhaseFeedback from './PhaseFeedback.svelte';
  import { cliveSessionFor, isFilled } from './cliveSession.svelte';
  import { PHASES, type ArtifactField } from './phase';
  import { askHint, submitPhase } from './api';
  import type { SolveWindowContext } from '../../../src/routes/problem/[problem_id]/[session_id]/context.svelte';

  interface Props {
    context: SolveWindowContext;
    phaseIndex: number;
  }

  let { context, phaseIndex }: Props = $props();

  let config = $derived(PHASES[phaseIndex]);
  let isCodePhase = $derived(config.artifactFields.some((f) => f.kind === 'code'));
  let session = $derived.by(() => cliveSessionFor(context.practiceSession.id, context.editorState.code));
  let phaseState = $derived(session.phases[phaseIndex]);

  const blank = $derived(config.artifactFields.every((f) => !isFilled(phaseState.artifact[f.id])));

  // The Implement phase's gate isn't "did you write something" -- AnimoRank's
  // own Code Editor window owns that field (see the `code`-kind branch below).
  // It's "has the code already passed AnimoRank's own tests", since a failing
  // submission there is AnimoRank's Submit flow to nudge, not this plugin's --
  // this button only ever runs the plan-vs-code advisory judge on code that
  // already works.
  const canCheckImplementation = $derived(context.testCaseResults.success && context.lastTestType === 'submit');

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
        ? `${session.busy === 'hint' ? 'A hint' : 'Checking'} can take up to a minute. Your work is saved, so please don't reload.`
        : ''
  );

  const recheck = $derived.by(() => {
    const out = new SvelteSet<string>();
    for (const v of phaseState.result?.verdicts ?? []) for (const label of v.recheck ?? []) out.add(label);
    return out;
  });

  /** A `cases` field's example rows, rendered the way the prototype showed them: numbered blocks of text. */
  function exampleCasesText(field: ArtifactField): string {
    const rows = Array.isArray(field.example) ? field.example : [];
    return (
      'For a different problem:\n\n' +
      rows
        .map((r, i) => `Case ${i + 1}\nInput: ${r.input}\nExpected output: ${r.output}\nHow I got it: ${r.working}`)
        .join('\n\n')
    );
  }

  /**
   * The persistence seam: the prototype wrote every keystroke to
   * `localStorage`, keyed by problem. Its counterpart here is
   * `savePracticeSession(context.practiceSession.id, { extension_data })`
   * (see `$lib/practiceSession/api`), left out until the phases are actually
   * judged server-side -- an in-memory-only draft is honest about what today's
   * stub backend can promise, and this is the one place to wire it in later.
   */
  function save(): void {}

  async function hint(): Promise<void> {
    session.busy = 'hint';
    session.busySince = Date.now();
    session.error = null;
    try {
      const history = phaseState.hints
        .slice()
        .reverse()
        .map((h) => ({ role: 'hint' as const, text: `${h.diagnosis} ${h.hint}` }));
      const got = await askHint({
        phase: config.phase,
        problemId: context.problem.id,
        artifact: phaseState.artifact,
        attempt: phaseState.attempt,
        priorArtifacts: session.priorArtifacts(phaseIndex),
        history
      });
      phaseState.hints.unshift({ ...got, attempt: phaseState.attempt });
    } catch (e) {
      session.error = e instanceof Error ? e.message : String(e);
    } finally {
      session.busy = null;
      session.busySince = null;
    }
  }

  async function submit(): Promise<void> {
    session.busy = 'submit';
    session.busySince = Date.now();
    session.error = null;
    phaseState.result = null;
    try {
      const r = await submitPhase({
        phase: config.phase,
        problemId: context.problem.id,
        artifact: phaseState.artifact,
        attempt: phaseState.attempt,
        priorArtifacts: session.priorArtifacts(phaseIndex)
      });
      phaseState.result = r;
      if (r.passed) session.pass(phaseIndex);
      else phaseState.attempt += 1;
    } catch (e) {
      session.error = e instanceof Error ? e.message : String(e);
    } finally {
      session.busy = null;
      session.busySince = null;
    }
  }

  function continueToNext(): void {
    const next = phaseIndex + 1;
    session.open(next);
    context.openWindow(`clive:${PHASES[next].phase}`);
  }
</script>

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

      <div class="flex items-baseline gap-2.5">
        <h2 class="font-display text-xl font-bold">{config.label}</h2>
        {#if phaseState.passed}<span class="font-mono text-xs font-normal text-base-content/50">Passed</span>{/if}
      </div>

      {#if phaseState.passed}
        <Alert class="bg-base-200 text-sm text-base-content/70">
          <span>You can keep improving this and submit again. It stays passed either way.</span>
        </Alert>
      {/if}

      <p
        class="max-w-[68ch] border-l-2 border-primary py-0.5 pl-4 text-sm leading-relaxed whitespace-pre-wrap text-base-content/70"
      >
        {config.taskDescription}
      </p>

      {#if config.references?.length}
        <div class="rounded-lg border border-base-content/10 bg-base-200 p-3.5 text-sm">
          <div class="mb-1.5 font-mono text-xs text-base-content/50">C reference</div>
          <ul class="list-disc pl-4">
            {#each config.references as ref (ref.url)}
              <li>
                <a
                  class="link text-primary"
                  href={ref.url}
                  target="_blank"
                  rel="noopener noreferrer">{ref.label}</a
                >
              </li>
            {/each}
          </ul>
          <div class="mt-1.5 text-base-content/60">Searching for documentation is fine. AI assistants are not.</div>
        </div>
      {/if}

      <div class="flex flex-col gap-5">
        {#each config.artifactFields as field (field.id)}
          <div class="flex flex-col gap-1.5">
            <span class="text-sm font-semibold">{field.label}</span>
            {#if field.hint}<span class="text-xs text-base-content/60">{field.hint}</span>{/if}

            {#if field.kind === 'code'}
              <div
                class="rounded-lg border border-dashed border-base-content/20 bg-base-200 px-3 py-2.5 text-sm text-base-content/60"
              >
                Edited in the Code Editor window. Run and Submit there check it against the examples and the hidden
                cases; "Check against your plan" below compares the code that passes against what you wrote in Cases and
                Design.
              </div>
            {:else}
              {#if field.example}
                <details class="text-xs">
                  <summary class="w-fit cursor-pointer font-medium text-primary">Show an example</summary>
                  <pre
                    class="mt-1.5 whitespace-pre-wrap rounded-lg bg-base-200 p-3 text-[13px] text-base-content/70">{Array.isArray(
                      field.example
                    )
                      ? exampleCasesText(field)
                      : field.example}</pre>
                </details>
              {/if}

              {#if field.kind === 'cases'}
                <CaseRows
                  label={field.label}
                  {recheck}
                  disabled={!!session.busy}
                  rows={phaseState.artifact[field.id]}
                  onchange={save}
                />
              {:else}
                <Textarea
                  rows={field.rows ?? 4}
                  bind:value={(phaseState.artifact as Record<string, string>)[field.id]}
                  disabled={!!session.busy}
                  oninput={save}
                />
              {/if}
            {/if}
          </div>
        {/each}
      </div>

      <div class="flex flex-wrap items-center gap-2.5">
        <Button
          class="btn-ghost gap-2"
          type="button"
          disabled={!!session.busy}
          onclick={hint}
        >
          <LightbulbIcon class="h-3.5 w-3.5" />
          {session.busy === 'hint' ? 'Thinking…' : "I'm stuck — get a hint"}
        </Button>
        {#if isCodePhase}
          <Button
            class="btn-primary"
            type="button"
            disabled={!!session.busy || !canCheckImplementation}
            onclick={submit}
          >
            {session.busy === 'submit' ? 'Checking…' : 'Check against your plan'}
          </Button>
          {#if !canCheckImplementation}
            <span class="font-mono text-xs text-base-content/50">Pass Submit in the Code Editor window first</span>
          {/if}
        {:else}
          <Button
            class="btn-primary"
            type="button"
            disabled={!!session.busy || blank}
            onclick={submit}
          >
            {session.busy === 'submit' ? 'Checking…' : 'Submit for checking'}
          </Button>
        {/if}
      </div>

      {#if session.busy}
        <div
          class="flex items-start gap-2.5 rounded-box border border-base-content/10 bg-base-200 p-4 text-sm text-base-content/70"
          role="status"
        >
          <span class="mt-1.5 h-2 w-2 shrink-0 animate-pulse rounded-full bg-primary"></span>
          <div class="flex flex-col gap-0.5">
            <div class="font-medium text-base-content">
              CLive is thinking… <span class="ml-2 font-mono text-xs text-base-content/50">{elapsed}s</span>
            </div>
            <div>
              {session.busy === 'submit'
                ? 'Checking your work against every requirement.'
                : 'Looking for somewhere useful to point.'}
            </div>
            {#if thinkNote}<div class="text-xs">{thinkNote}</div>{/if}
          </div>
        </div>
      {/if}

      {#if phaseState.passed}
        {@const next = PHASES[phaseIndex + 1]}
        {@const advisoryUnmet = phaseState.result?.advisory_unmet.length ?? 0}
        <Alert class="alert-success">
          <span>
            {next ? `Phase passed. ${next.label} is open.` : 'Phase passed. That was the last one.'}
            {#if advisoryUnmet}
              {advisoryUnmet} optional point{advisoryUnmet > 1 ? 's' : ''} went unmet — worth a look before you move on.
            {/if}
          </span>
        </Alert>
      {/if}

      <PhaseFeedback
        {isCodePhase}
        hints={phaseState.hints}
        result={phaseState.result}
      />

      {#if phaseState.passed && PHASES[phaseIndex + 1] && session.phases[phaseIndex + 1].unlocked && !session.busy}
        <div class="flex justify-end">
          <Button
            class="btn-primary gap-2"
            type="button"
            onclick={continueToNext}
          >
            Continue to {PHASES[phaseIndex + 1].label}
            <ArrowRightIcon class="h-3 w-3" />
          </Button>
        </div>
      {/if}

      {#if phaseState.passed && phaseIndex === PHASES.length - 1}
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
