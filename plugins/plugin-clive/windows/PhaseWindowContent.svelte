<script lang="ts">
  import { SvelteSet } from 'svelte/reactivity';
  import Textarea from '$lib/components/ui/textareas/Textarea.svelte';
  import Button from '$lib/components/ui/buttons/Button.svelte';
  import Alert from '$lib/components/ui/alerts/Alert.svelte';
  import LightbulbIcon from '@iconify-svelte/fa6-solid/lightbulb';
  import ArrowRightIcon from '@iconify-svelte/fa6-solid/arrow-right';
  import CaseRows from './CaseRows.svelte';
  import PhaseFeedback from './PhaseFeedback.svelte';
  import OutlineEditor from './OutlineEditor.svelte';
  import { cliveSessionFor, type JudgeResult } from './cliveSession.svelte';
  import {
    PHASES,
    duplicateOf,
    isFilled,
    isPerStep,
    isStepped,
    outlineText,
    stepComplete,
    type ArtifactField,
    type CaseRow,
    type OutlineRow
  } from './phase';
  import { askHint, submitPhase, type JudgeContext } from './api';
  import type { SolveWindowContext } from '../../../src/routes/problem/[problem_id]/[session_id]/context.svelte';

  interface Props {
    context: SolveWindowContext;
    phaseIndex: number;
  }

  let { context, phaseIndex }: Props = $props();

  let config = $derived(PHASES[phaseIndex]);
  let stepped = $derived(isStepped(config));
  let perStep = $derived(isPerStep(config));
  let isCodePhase = $derived(config.artifactFields.some((f) => f.kind === 'code'));
  let session = $derived.by(() => cliveSessionFor(context));
  let phaseState = $derived(session.phases[phaseIndex]);
  let fields = $derived(session.inPlay(phaseIndex));

  /** The step a stepped phase shows, clamped so a stale index can never throw. */
  let openIndex = $derived(stepped ? Math.max(0, Math.min(phaseState.step || 0, fields.length - 1)) : 0);
  let openField = $derived(stepped ? fields[openIndex] : config.artifactFields[0]);

  /** The result the current step reads: its own in a per-step phase, the phase's otherwise. */
  let current = $derived(
    stepped && openField
      ? session.stateFor(phaseIndex, openField.id)
      : { result: phaseState.result, passed: phaseState.passed, attempt: phaseState.attempt }
  );

  const blank = $derived(
    perStep && openField
      ? !stepComplete(openField, phaseState.artifact[openField.id])
      : stepped
        ? fields.some((f) => !isFilled(phaseState.artifact[f.id]))
        : config.artifactFields.every((f) => !isFilled(phaseState.artifact[f.id]))
  );

  const duplicate = $derived(
    perStep && openField ? duplicateOf(config, phaseState.artifact, openField, phaseState.added) : null
  );

  // The Implement phase's gate isn't "did you write something" -- AnimoRank's own
  // Code Editor window owns that field. It's "has the code already passed
  // AnimoRank's own tests", since a failing submission there is AnimoRank's Submit
  // flow to nudge, not this plugin's.
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
    for (const v of current.result?.verdicts ?? []) for (const label of v.recheck ?? []) out.add(label);
    return out;
  });

  function save(): void {
    session.persist();
  }

  /** A `cases` field's example rows, rendered the way the prototype showed them. */
  function exampleCasesText(field: ArtifactField): string {
    const rows = (Array.isArray(field.example) ? field.example : []) as CaseRow[];
    return (
      'For a different problem:\n\n' +
      rows
        .map(
          (row, i) => `Case ${i + 1}\nInput: ${row.input}\nExpected output: ${row.output}\nHow I got it: ${row.working}`
        )
        .join('\n\n')
    );
  }

  function exampleText(field: ArtifactField): string {
    if (field.kind === 'steps') return outlineText((field.example as OutlineRow[]) ?? []);
    if (Array.isArray(field.example)) return exampleCasesText(field);
    return String(field.example ?? '');
  }

  function goStep(j: number): void {
    phaseState.step = j;
    save();
  }

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
        attempt: current.attempt,
        priorArtifacts: session.priorArtifacts(phaseIndex),
        history
      });
      phaseState.hints.unshift({ ...got, attempt: current.attempt });
    } catch (e) {
      session.error = e instanceof Error ? e.message : String(e);
    } finally {
      session.busy = null;
      session.busySince = null;
      save();
    }
  }

  async function submit(): Promise<void> {
    session.busy = 'submit';
    session.busySince = Date.now();
    session.error = null;
    const step = perStep && openField ? openField.id : undefined;
    try {
      const payload: JudgeContext = {
        phase: config.phase,
        problemId: context.problem.id,
        artifact: phaseState.artifact,
        attempt: current.attempt,
        priorArtifacts: session.priorArtifacts(phaseIndex),
        ...(step ? { step } : {}),
        ...(isCodePhase ? { code: context.editorState.code } : {})
      };
      const result: JudgeResult = await submitPhase(payload);
      if (step) session.completeStep(phaseIndex, step, result);
      else session.recordResult(phaseIndex, result);
    } catch (e) {
      session.error = e instanceof Error ? e.message : String(e);
    } finally {
      session.busy = null;
      session.busySince = null;
      save();
    }
  }

  function continueToNext(): void {
    const next = phaseIndex + 1;
    session.open(next);
    context.openWindow(`clive:${PHASES[next].phase}`);
  }

  /** Cases: once the required cases pass, the way on is a question, with the option of another case. */
  const requiredPassed = $derived(
    perStep && config.artifactFields.filter((f) => !f.added).every((f) => session.stateFor(phaseIndex, f.id).passed)
  );
  const allInPlayPassed = $derived(fields.every((f) => session.stateFor(phaseIndex, f.id).passed));
  const nextPhase = $derived(PHASES[phaseIndex + 1]);

  function addCase(): void {
    phaseState.added += 1;
    phaseState.step = session.inPlay(phaseIndex).length - 1;
    save();
  }

  function removeCase(): void {
    const last = session.inPlay(phaseIndex).at(-1);
    if (!last?.added) return;
    phaseState.artifact[last.id] = [{ input: '', output: '', working: '' }];
    delete phaseState.stepResults[last.id];
    phaseState.added -= 1;
    phaseState.step = session.inPlay(phaseIndex).length - 1;
    save();
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

      {#snippet fieldEditor(field: ArtifactField)}
        <div class="flex flex-col gap-1.5">
          <span class="text-sm font-semibold">{field.prompt ?? field.label}</span>
          {#if field.hint}<span class="text-xs text-base-content/60">{field.hint}</span>{/if}

          {#if field.kind === 'code'}
            <div
              class="rounded-lg border border-dashed border-base-content/20 bg-base-200 px-3 py-2.5 text-sm text-base-content/60"
            >
              Edited in the Code Editor window. Run and Submit there check it against the examples and the hidden cases;
              "Check against your plan" below compares the code that passes against what you wrote in Cases and Design.
            </div>
          {:else}
            {#if field.example}
              <details class="text-xs">
                <summary class="w-fit cursor-pointer font-medium text-primary">Show an example</summary>
                {#if config.exampleProblem}
                  <p class="mt-1.5 text-xs text-base-content/70">{config.exampleProblem}</p>
                {/if}
                <pre
                  class="mt-1.5 whitespace-pre-wrap rounded-lg bg-base-200 p-3 text-[13px] text-base-content/70">{exampleText(
                    field
                  )}</pre>
              </details>
            {/if}

            {#if field.kind === 'cases'}
              <CaseRows
                label={field.label}
                {recheck}
                disabled={!!session.busy}
                single={perStep}
                rows={phaseState.artifact[field.id]}
                onchange={save}
              />
              {#if duplicate}
                <p class="text-xs text-error">Use a different input from {duplicate.label}.</p>
              {/if}
            {:else if field.kind === 'steps'}
              <OutlineEditor
                rows={phaseState.artifact[field.id] as OutlineRow[]}
                disabled={!!session.busy}
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
      {/snippet}

      <div class="flex flex-col gap-5">
        {#if stepped && openField}
          {@render fieldEditor(openField)}
        {:else}
          {#each config.artifactFields as field (field.id)}
            {@render fieldEditor(field)}
          {/each}
        {/if}
      </div>

      {#if stepped && fields.length > 1}
        <div class="flex flex-wrap gap-1.5">
          {#each fields as field, j (field.id)}
            {@const stepResult = session.stateFor(phaseIndex, field.id)}
            {@const here = j === openIndex}
            {@const open = session.stepOpen(phaseIndex, j)}
            <Button
              class="btn-sm gap-1.5 {here ? 'btn-primary' : 'btn-ghost'} {!open ? 'btn-disabled' : ''}"
              type="button"
              disabled={!!session.busy || (!here && !open)}
              title={open ? undefined : 'Opens once the case before it has passed.'}
              onclick={() => goStep(j)}
            >
              <span class="font-mono text-xs">{j + 1}</span>
              <span>{field.label}</span>
              {#if stepResult.passed}<span class="text-success">✓</span>{/if}
            </Button>
          {/each}
        </div>
      {/if}

      <div class="flex flex-wrap items-center gap-2.5">
        <Button
          class="btn-ghost gap-2"
          type="button"
          disabled={!!session.busy || !session.hasApiKey}
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
          {@const showSubmit = perStep || !stepped || openIndex === fields.length - 1 || phaseState.attempt > 1}
          {#if showSubmit}
            <Button
              class="btn-primary"
              type="button"
              disabled={!!session.busy || blank || !!duplicate}
              onclick={submit}
            >
              {session.busy === 'submit' ? 'Checking…' : current.attempt > 1 ? 'Resubmit' : 'Submit for checking'}
            </Button>
          {:else}
            <Button
              class="btn-ghost gap-2"
              type="button"
              disabled={!!session.busy}
              onclick={() => goStep(openIndex + 1)}
            >
              Next: {fields[openIndex + 1]?.label}
              <ArrowRightIcon class="h-3 w-3" />
            </Button>
          {/if}
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
        {@const advisoryUnmet = current.result?.advisory_unmet.length ?? 0}
        <Alert class="alert-success">
          <span>
            {nextPhase ? `Phase passed. ${nextPhase.label} is open.` : 'Phase passed. That was the last one.'}
            {#if advisoryUnmet}
              {advisoryUnmet} optional point{advisoryUnmet > 1 ? 's' : ''} went unmet — worth a look before you move on.
            {/if}
          </span>
        </Alert>
      {/if}

      <PhaseFeedback
        {isCodePhase}
        hints={phaseState.hints}
        result={current.result}
      />

      {#if requiredPassed}
        <div class="flex flex-col gap-2 rounded-box border border-base-content/10 bg-base-200 p-4">
          <p class="text-sm">
            {allInPlayPassed ? 'Your cases work.' : 'Your first two cases work.'}
            {nextPhase ? `Are you ready to move on to ${nextPhase.label}?` : ''}
          </p>
          <div class="flex flex-wrap gap-2">
            {#if nextPhase && session.phases[phaseIndex + 1]?.unlocked && !session.busy}
              <Button
                class="btn-primary gap-2"
                type="button"
                onclick={continueToNext}
              >
                Yes, continue to {nextPhase.label}
                <ArrowRightIcon class="h-3 w-3" />
              </Button>
            {/if}
            {#if allInPlayPassed && phaseState.added < config.artifactFields.filter((f) => f.added).length && !session.busy}
              <Button
                class="btn-ghost"
                type="button"
                onclick={addCase}>Add another case</Button
              >
            {/if}
            {#if openField?.added && !session.busy}
              <Button
                class="btn-ghost"
                type="button"
                onclick={removeCase}>Remove this case</Button
              >
            {/if}
          </div>
        </div>
      {:else if phaseState.passed && !perStep && nextPhase && session.phases[phaseIndex + 1]?.unlocked && !session.busy}
        <div class="flex justify-end">
          <Button
            class="btn-primary gap-2"
            type="button"
            onclick={continueToNext}
          >
            Continue to {nextPhase.label}
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
