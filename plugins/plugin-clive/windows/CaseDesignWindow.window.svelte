<script lang="ts">
  import { untrack } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import Textarea from '$lib/components/ui/textareas/Textarea.svelte';
  import Button from '$lib/components/ui/buttons/Button.svelte';
  import Alert from '$lib/components/ui/alerts/Alert.svelte';
  import ArrowRightIcon from '@iconify-svelte/fa6-solid/arrow-right';
  import TriangleExclamationIcon from '@iconify-svelte/fa6-solid/triangle-exclamation';
  import FieldFeedback from './FieldFeedback.svelte';
  import { cliveSessionFor, type JudgeResult } from './cliveSession.svelte';
  import { isFunctionProblem } from './problemKind';
  import { PHASES, duplicateOf, isFilled, maxAdded, rowsOf, type CaseRow } from './phase';
  import { canEscalate, casePartFor, fieldFeedback, fieldMark } from './feedback';
  import { submitPhase, type JudgeContext } from './api';
  import { CLIVE_EVENT } from './telemetry';
  import type { SolveWindowContext } from '../../../src/routes/problem/[problem_id]/[session_id]/context.svelte';

  // `phaseIndex` is fixed per window file rather than taken as a prop: `Window`
  // types its mounted component as `Component<{ context: T }>` (see
  // `$lib/window/index.ts`), so a required extra prop here would fail that type
  // even though `options.props` does forward it at runtime.
  let { context }: { context: SolveWindowContext } = $props();

  /**
   * Phase 2 of PCDIT, `case_design`: the problem solved by hand, one case at a
   * time, each judged on its own. Every word the student reads is here rather
   * than in `phase.ts`, which keeps only what the server contract needs. Case 1
   * and 2 are required; Cases 3-5 are offered once both have passed.
   */
  const config = PHASES[1];
  /** The phase after this one, for the "Phase passed" line and the way on. */
  const nextPhase = PHASES[2];

  /**
   * The question, hint and worked cases, for a problem that reads and prints and for
   * one that asks for a function, each with a sample problem of its own kind: a normal
   * case for Case 1, an edge one after it.
   */
  const PROGRAM_COPY = {
    exampleProblem:
      'Read the length and width of a rectangle, each a whole number of centimeters from 1 to\n100. Print the area.',
    question: 'Pick some values and solve the problem by hand.',
    hint: 'Write the values you would type in, and work out by hand the output. Do not use values provided by the examples in the problem.',
    normalExample: [{ input: '4 6', output: '24', working: '4 * 6 = 24.' }] as CaseRow[],
    edgeExample: [
      { input: '1 1', output: '1', working: 'The smallest length and width allowed are 1 and 1. 1 * 1 = 1.' }
    ] as CaseRow[],
    // The shape of a case, in the empty boxes: a round 6 student wrote seven cases
    // without the arithmetic, and the box itself never said what goes in it.
    inputPlaceholder: 'What you would type in, e.g. 4 6',
    outputPlaceholder: 'Exactly what it prints, e.g. 24',
    workingPlaceholder: 'The working, one step per line, with the real numbers: 4 * 6 = 24, so it prints 24.'
  };
  const FUNCTION_COPY = {
    exampleProblem:
      'Write a function int getArea(int nLength, int nWidth) that returns the area of a rectangle whose\nlength and width are each a whole number of centimeters from 1 to 100.',
    question: 'Pick some values and solve the problem by hand.',
    hint: 'Write the values you would pass it, and work out by hand the output. Do not use values provided by the examples in the problem.',
    normalExample: [{ input: '4, 6', output: '24', working: '4 * 6 = 24.' }] as CaseRow[],
    edgeExample: [
      { input: '1, 1', output: '1', working: 'The smallest length and width allowed are 1 and 1. 1 * 1 = 1.' }
    ] as CaseRow[],
    inputPlaceholder: 'The values you pass it, in parameter order, separated by commas, e.g. 4, 6',
    outputPlaceholder: 'What it returns, e.g. 24',
    workingPlaceholder: 'The working, one step per line, with the real numbers: 4 * 6 = 24, so it returns 24.'
  };

  /** A case example, rendered the way the prototype showed it. */
  function exampleCasesText(rows: CaseRow[]): string {
    return (
      'For a different problem:\n\n' +
      rows
        .map(
          (row, i) => `Case ${i + 1}\nInput: ${row.input}\nExpected output: ${row.output}\nHow I got it: ${row.working}`
        )
        .join('\n\n')
    );
  }

  let session = $derived(cliveSessionFor(context));
  let copy = $derived(isFunctionProblem(context.problem.extension_data) ? FUNCTION_COPY : PROGRAM_COPY);
  let phaseState = $derived(session.phases[1]);
  let fields = $derived(session.inPlay(1));

  // Every `cases` field holds a list of rows, and the boxes below bind straight
  // into this step's row. A value still saved in the prototype's free-text shape
  // is turned into that row once, as the window opens (`rowsOf`), since a form
  // bound to a copy of a row would drop everything the student typed.
  untrack(() => {
    for (const field of config.artifactFields) {
      if (!Array.isArray(phaseState.artifact[field.id])) {
        phaseState.artifact[field.id] = rowsOf(phaseState.artifact[field.id]);
      }
    }
  });

  /** The case on screen, clamped so a stale saved step can never throw. */
  let openIndex = $derived(Math.max(0, Math.min(phaseState.step || 0, fields.length - 1)));
  let openField = $derived(fields[openIndex]);

  let current = $derived(session.stateFor(1, openField.id));
  /** The box of this case the feedback is about, while the case has not passed. */
  const flaggedPart = $derived(current.passed ? null : casePartFor(current.result?.nudge?.focus_id));
  const FLAGGED = 'textarea-error';

  /**
   * Whether this case is still empty: Submit waits only for something to judge,
   * as it does in every other phase. A case filled in only half-way submits, and
   * the rubric says what is missing -- `case_is_concrete` and `work_is_shown` are
   * both gating, each with its own line and nudge -- which is better than a
   * button that stays dead with nothing on screen to explain why.
   */
  const blank = $derived(!isFilled(phaseState.artifact[openField.id]));

  /** The earlier case whose input this one repeats; Submit waits for a new one. */
  const duplicate = $derived(duplicateOf(config, phaseState.artifact, openField, phaseState.added));

  /** The rows the judge asked the student to re-check, by name (see `Verdict.recheck`). */
  const recheck = $derived.by(() => {
    const out = new SvelteSet<string>();
    for (const v of current.result?.verdicts ?? []) for (const label of v.recheck ?? []) out.add(label);
    return out;
  });

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
        ? `${session.busy === 'escalate' ? 'An answer' : 'Checking'} can take up to a minute. Your work is saved, so please don't reload.`
        : ''
  );

  /** Once the two required cases pass, the way on is a question, with the option of another case. */
  const requiredPassed = $derived(
    config.artifactFields.filter((f) => !f.added).every((f) => session.stateFor(1, f.id).passed)
  );
  const allInPlayPassed = $derived(fields.every((f) => session.stateFor(1, f.id).passed));

  // What the judge's reply has to show, read out of the step's own result, one
  // thing at a time (see `feedback.ts`): no list of every requirement is put in
  // front of the student.
  const feedback = $derived(fieldFeedback(current.result, openField.id, true));
  const nudgeError = $derived(current.result?.nudge_error);
  /** A requirement the judge never ruled on belongs to no case, so it is said once, above the case. */
  const missingIds = $derived(current.result?.missing_ids ?? []);

  function save(): void {
    session.persist();
  }

  /** Move to another case, remembering it for a reload. */
  function goStep(j: number): void {
    phaseState.step = j;
    save();
  }

  async function submit(): Promise<void> {
    session.busy = 'submit';
    session.busySince = Date.now();
    session.error = null;
    const step = openField.id;
    // Read before the call: a failing step increments its own attempt below, and the
    // attempt being submitted is the one the student made.
    const attempt = current.attempt;
    try {
      const payload: JudgeContext = {
        sessionId: context.practiceSession.id,
        phase: config.phase,
        problemId: context.problem.id,
        artifact: phaseState.artifact,
        attempt,
        priorArtifacts: session.priorArtifacts(1),
        history: session.historyFor(1, step),
        step
      };
      const result: JudgeResult = await submitPhase(payload);
      session.completeStep(1, step, result);
    } catch (e) {
      session.error = e instanceof Error ? e.message : String(e);
    } finally {
      session.busy = null;
      session.busySince = null;
      save();
    }
  }

  function continueToNext(): void {
    session.open(2);
    context.telemetry.record(CLIVE_EVENT.phaseOpen, { phase: nextPhase.phase, via: 'continue' });
    context.openWindow(`clive:${nextPhase.phase}`);
  }

  /** Another case is a row of its own, on a step of its own at the end. */
  function addCase(): void {
    phaseState.added += 1;
    phaseState.step = session.inPlay(1).length - 1;
    context.telemetry.record(CLIVE_EVENT.caseAdded, { phase: config.phase, cases: session.inPlay(1).length });
    save();
  }

  function removeCase(): void {
    const last = session.inPlay(1).at(-1);
    if (!last?.added) return;
    phaseState.artifact[last.id] = [{ input: '', output: '', working: '' }];
    delete phaseState.stepResults[last.id];
    delete phaseState.passedArtifact[last.id];
    phaseState.added -= 1;
    phaseState.step = session.inPlay(1).length - 1;
    context.telemetry.record(CLIVE_EVENT.caseRemoved, { phase: config.phase, cases: session.inPlay(1).length });
    save();
  }
</script>

<div class="h-full min-w-0 overflow-y-auto">
  <!-- A submit waits where its feedback will go, in place of the last one; "I'm stuck"
       waits on the card, under the hint its prompt will go beneath. -->
  {#snippet thinking()}
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
  {/snippet}

  {#if !phaseState.unlocked}
    <div class="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <p class="max-w-[34ch] text-sm text-base-content/70">
        {config.label} opens once you have passed the phase before it.
      </p>
    </div>
  {:else}
    {@const row = (phaseState.artifact[openField.id] as CaseRow[])[0]}
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

      {#if missingIds.length}
        <Alert class="alert-warning">
          <TriangleExclamationIcon class="h-4 w-4" />
          <span>
            Part of your work came back unchecked. That is a fault on our side, not yours — submitting again usually
            settles it.
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
        Before you plan anything, solve the problem yourself.
      </p>

      <div class="flex flex-col gap-1.5">
        <span class="text-sm font-semibold">{copy.question}</span>
        <span class="text-xs text-base-content/60">{copy.hint}</span>

        <details class="text-xs">
          <summary class="w-fit cursor-pointer font-medium text-primary">Show an example</summary>
          <p class="mt-1.5 text-xs text-base-content/70">{copy.exampleProblem}</p>
          <pre
            class="mt-1.5 whitespace-pre-wrap rounded-lg bg-base-200 p-3 text-[13px] text-base-content/70">{exampleCasesText(
              openField.id === 'normal_cases' ? copy.normalExample : copy.edgeExample
            )}</pre>
        </details>

        <!-- One case, the shape this phase always shows: no per-row header, no add or
             remove of its own -- both are the phase's, at the end of the page. -->
        <div
          class="rounded-lg border p-3 pb-3.5 {recheck.has(openField.label)
            ? 'border-error shadow-[inset_3px_0_0_var(--color-error)]'
            : 'border-base-content/15'} bg-base-200"
        >
          <div class="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            <label class="flex flex-col gap-1 text-xs text-base-content/70">
              <span>Input</span>
              <Textarea
                rows={2}
                class="font-mono text-sm {flaggedPart === 'input' ? FLAGGED : ''}"
                aria-label={`Input, ${openField.label}`}
                placeholder={copy.inputPlaceholder}
                data-case-part-flagged={flaggedPart === 'input' ? '' : undefined}
                bind:value={row.input}
                disabled={!!session.busy}
                oninput={save}
              />
            </label>
            <label class="flex flex-col gap-1 text-xs text-base-content/70">
              <span>Expected output</span>
              <Textarea
                rows={2}
                class="font-mono text-sm {flaggedPart === 'output' ? FLAGGED : ''}"
                aria-label={`Expected output, ${openField.label}`}
                placeholder={copy.outputPlaceholder}
                data-case-part-flagged={flaggedPart === 'output' ? '' : undefined}
                bind:value={row.output}
                disabled={!!session.busy}
                oninput={save}
              />
            </label>
          </div>
          <label class="mt-2 flex flex-col gap-1 text-xs text-base-content/70">
            <span>How I got it</span>
            <Textarea
              rows={3}
              class={flaggedPart === 'working' ? FLAGGED : ''}
              aria-label={`How I got it, ${openField.label}`}
              placeholder={copy.workingPlaceholder}
              data-case-part-flagged={flaggedPart === 'working' ? '' : undefined}
              bind:value={row.working}
              disabled={!!session.busy}
              oninput={save}
            />
          </label>
        </div>

        {#if duplicate}
          <p class="text-xs text-error">Use a different input from {duplicate.label}.</p>
        {/if}
      </div>

      {#if session.busy === 'submit'}
        {@render thinking()}
      {:else if feedback}
        <FieldFeedback
          {feedback}
          canEscalate={canEscalate(
            !!current.result && !current.result.passed,
            session.historyFor(1, openField.id),
            current.result?.nudge?.focus_id
          )}
          disabled={!!session.busy || !session.hasApiKey}
          onescalate={() => session.escalate(1, openField.id, context.problem.id)}
          waiting={session.busy === 'escalate' ? thinking : undefined}
        />
      {/if}

      {#if fields.length > 1}
        <div class="flex flex-wrap gap-1.5">
          {#each fields as field, j (field.id)}
            {@const mark = fieldMark(session.stateFor(1, field.id).result, field.id)}
            {@const here = j === openIndex}
            {@const open = session.stepOpen(1, j)}
            <!-- The number says how the case did on its last submit: red while a
                 required point fails on it, green otherwise, with a dot for a point
                 worth a look. -->
            <Button
              class="btn-sm gap-1.5 {here ? 'btn-primary' : 'btn-ghost'} {!open ? 'btn-disabled' : ''}"
              type="button"
              disabled={!!session.busy || (!here && !open)}
              title={open ? undefined : 'Opens once the case before it has passed.'}
              data-mark={mark}
              onclick={() => goStep(j)}
            >
              <span
                class="grid h-5 w-5 place-items-center rounded font-mono text-xs {mark === 'bad'
                  ? 'bg-error/15 text-error'
                  : mark
                    ? 'bg-success/15 text-success'
                    : ''}">{j + 1}</span
              >
              <span>{field.label}</span>
              {#if mark === 'look'}<span
                  class="h-1.5 w-1.5 rounded-full bg-warning"
                  title="Worth a look"
                ></span>{/if}
            </Button>
          {/each}
        </div>
      {/if}

      <div class="flex flex-wrap items-center gap-2.5">
        <!-- After a pass the way on leads and this steps back: a still-primary Submit
             reads as the thing to click when the student means to move on. -->
        <Button
          class={phaseState.passed ? 'btn-ghost' : 'btn-primary'}
          type="button"
          disabled={!!session.busy || blank || !!duplicate}
          onclick={submit}
        >
          {session.busy === 'submit' ? 'Checking…' : phaseState.passed || current.attempt > 1 ? 'Resubmit' : 'Submit'}
        </Button>
      </div>

      {#if phaseState.passed}
        {@const advisoryUnmet = current.result?.advisory_unmet.length ?? 0}
        <Alert class="alert-success">
          <span>
            Phase passed. {nextPhase.label} is open.
            {#if advisoryUnmet}
              {advisoryUnmet} optional point{advisoryUnmet > 1 ? 's' : ''} went unmet — worth a look. Optional points never
              stop you from moving on.
            {/if}
          </span>
        </Alert>
      {/if}

      {#if nudgeError}
        <Alert class="alert-warning">
          <TriangleExclamationIcon class="h-4 w-4" />
          <span>Your work was checked, but we could not put together a next step: {nudgeError}</span>
        </Alert>
      {/if}

      {#if requiredPassed}
        <div class="flex flex-col gap-2 rounded-box border border-base-content/10 bg-base-200 p-4">
          <p class="text-sm">
            {allInPlayPassed ? 'Your cases work.' : 'Your first two cases work.'}
            Are you ready to move on to {nextPhase.label}?
          </p>
          <div class="flex flex-wrap gap-2">
            {#if session.phases[2]?.unlocked && !session.busy}
              <Button
                class="btn-primary gap-2"
                type="button"
                onclick={continueToNext}
              >
                Yes, continue to {nextPhase.label}
                <ArrowRightIcon class="h-3 w-3" />
              </Button>
            {/if}
            {#if allInPlayPassed && phaseState.added < maxAdded(config) && !session.busy}
              <Button
                class="btn-ghost"
                type="button"
                onclick={addCase}>Add another case</Button
              >
            {/if}
            {#if openField.added && !session.busy}
              <Button
                class="btn-ghost"
                type="button"
                onclick={removeCase}>Remove this case</Button
              >
            {/if}
          </div>
        </div>
      {/if}
    </div>
  {/if}
</div>
