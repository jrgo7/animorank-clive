<script lang="ts">
  import { untrack } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import Textarea from '$lib/components/ui/textareas/Textarea.svelte';
  import Button from '$lib/components/ui/buttons/Button.svelte';
  import Alert from '$lib/components/ui/alerts/Alert.svelte';
  import Badge from '$lib/components/ui/badges/Badge.svelte';
  import LightbulbIcon from '@iconify-svelte/fa6-solid/lightbulb';
  import ArrowRightIcon from '@iconify-svelte/fa6-solid/arrow-right';
  import TriangleExclamationIcon from '@iconify-svelte/fa6-solid/triangle-exclamation';
  import ProblemDescription from '$lib/components/content/ProblemDescription.svelte';
  import { cliveSessionFor, type JudgeResult } from './cliveSession.svelte';
  import { PHASES, duplicateOf, isFilled, maxAdded, rowsOf, type CaseRow } from './phase';
  import { askStuck, submitPhase, type JudgeContext } from './api';
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

  /** The sample problem each case's example answers, shown above the example. */
  const EXAMPLE_PROBLEM =
    'Read the length and width of a rectangle, each a whole number of centimeters from 1 to\n100. Print the area.';

  const CASE_QUESTION =
    'Pick some values and solve the problem by hand, the way your program will have to. What would you type in, what should it display, and how did you get there?';
  const CASE_HINT = 'Type the input as you would in the program, then work out the output by hand and show how.';

  /** The worked cases the example shows: a normal one for Case 1, an edge one after it. */
  const NORMAL_EXAMPLE: CaseRow[] = [{ input: '4 6', output: '24', working: '4 * 6 = 24.' }];
  const EDGE_EXAMPLE: CaseRow[] = [
    { input: '1 1', output: '1', working: 'The smallest length and width allowed are 1 and 1. 1 * 1 = 1.' }
  ];

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
        ? `${session.busy === 'stuck' ? 'An answer' : 'Checking'} can take up to a minute. Your work is saved, so please don't reload.`
        : ''
  );

  /** Once the two required cases pass, the way on is a question, with the option of another case. */
  const requiredPassed = $derived(
    config.artifactFields.filter((f) => !f.added).every((f) => session.stateFor(1, f.id).passed)
  );
  const allInPlayPassed = $derived(fields.every((f) => session.stateFor(1, f.id).passed));

  /** One failure shown at a time, with a line saying the rest will be checked again. */
  const MORE_TO_FIX = "There may be other things to fix. Submit again once this one's done and I'll check.";

  /** The requirement line, read as something to do: `Check this: …`. */
  const notYet = (text: string) =>
    `Check this: ${/^[A-Z][a-z]/.test(text || '') ? text[0].toLowerCase() + text.slice(1) : text || ''}`;

  const badgeFor = (v: JudgeResult['verdicts'][number]) =>
    v.verdict === 'PASS'
      ? { class: 'badge-success', text: 'Met' }
      : v.gate === 'advisory'
        ? { class: 'badge-warning', text: 'Depth' }
        : { class: 'badge-error', text: 'Blocks' };

  // What the judge's reply has to show, read out of the step's own result. Derived
  // here rather than inline in the markup, so each block reads as the one thing it
  // renders.
  const nudge = $derived(current.result?.nudge);
  /** The one requirement the nudge is about. */
  const focus = $derived.by(() => {
    const n = nudge;
    return n ? (n.failing.find((f) => f.id === n.focus_id) ?? n.failing[0]) : undefined;
  });
  /** The line above the nudge that says what to do, in the requirement's own words. */
  const focusLine = $derived(nudge ? nudge.focus_not_met || notYet(focus?.text ?? '') : '');
  const nudgeError = $derived(current.result?.nudge_error);
  const verdicts = $derived(current.result?.verdicts ?? []);
  const missingIds = $derived(current.result?.missing_ids ?? []);
  const latestStuck = $derived(phaseState.stuck[0]);
  const olderStuck = $derived(phaseState.stuck.slice(1));

  function save(): void {
    session.persist();
  }

  /** Move to another case, remembering it for a reload. */
  function goStep(j: number): void {
    phaseState.step = j;
    save();
  }

  async function ask(): Promise<void> {
    const statement = phaseState.stuckDraft.trim();
    if (!statement) return;
    session.busy = 'stuck';
    session.busySince = Date.now();
    session.error = null;
    try {
      // Oldest first, so the model reads them in the order the student did and does not repeat itself.
      const history = phaseState.stuck
        .slice()
        .reverse()
        .map((x) => ({ statement: x.statement, feedback: x.feedback }));
      const got = await askStuck({
        sessionId: context.practiceSession.id,
        phase: config.phase,
        problemId: context.problem.id,
        artifact: phaseState.artifact,
        attempt: current.attempt,
        priorArtifacts: session.priorArtifacts(1),
        statement,
        // The cases are per-step, and no one of them is the field the student is on.
        fieldId: null,
        history
      });
      phaseState.stuck.unshift({ statement, feedback: got.feedback, fieldId: null, attempt: current.attempt });
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
    phaseState.added -= 1;
    phaseState.step = session.inPlay(1).length - 1;
    context.telemetry.record(CLIVE_EVENT.caseRemoved, { phase: config.phase, cases: session.inPlay(1).length });
    save();
  }
</script>

<div class="h-full min-w-0 overflow-y-auto">
  {#snippet statement(open: boolean)}
    {#if open}
      <div class="rounded-box border border-base-content/10 bg-base-200 p-5">
        <ProblemDescription problem={context.problem} />
      </div>
    {:else}
      <details class="rounded-box border border-base-content/10 bg-base-200 p-4">
        <summary class="w-fit cursor-pointer text-sm font-medium text-primary">Problem statement</summary>
        <div class="mt-2"><ProblemDescription problem={context.problem} /></div>
      </details>
    {/if}
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
        Before you plan anything, solve the problem yourself. If you can't work out an example by hand, you can't tell a
        computer how to.
      </p>

      {@render statement(false)}

      <div class="flex flex-col gap-1.5">
        <span class="text-sm font-semibold">{CASE_QUESTION}</span>
        <span class="text-xs text-base-content/60">{CASE_HINT}</span>

        <details class="text-xs">
          <summary class="w-fit cursor-pointer font-medium text-primary">Show an example</summary>
          <p class="mt-1.5 text-xs text-base-content/70">{EXAMPLE_PROBLEM}</p>
          <pre
            class="mt-1.5 whitespace-pre-wrap rounded-lg bg-base-200 p-3 text-[13px] text-base-content/70">{exampleCasesText(
              openField.id === 'normal_cases' ? NORMAL_EXAMPLE : EDGE_EXAMPLE
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
                class="font-mono text-sm"
                aria-label={`Input, ${openField.label}`}
                bind:value={row.input}
                disabled={!!session.busy}
                oninput={save}
              />
            </label>
            <label class="flex flex-col gap-1 text-xs text-base-content/70">
              <span>Expected output</span>
              <Textarea
                rows={2}
                class="font-mono text-sm"
                aria-label={`Expected output, ${openField.label}`}
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
              aria-label={`How I got it, ${openField.label}`}
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

      {#if fields.length > 1}
        <div class="flex flex-wrap gap-1.5">
          {#each fields as field, j (field.id)}
            {@const stepResult = session.stateFor(1, field.id)}
            {@const here = j === openIndex}
            {@const open = session.stepOpen(1, j)}
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

      <!-- "What are you stuck on?": the student says what they find hard, in their own
           words, and gets a few lines back. The only help on the page since 2026-10-10. -->
      <div class="flex flex-col gap-2.5">
        {#if phaseState.stuckOpen || session.busy === 'stuck'}
          <div class="flex flex-col gap-2 rounded-box border border-base-content/10 bg-base-200 p-4">
            <label
              class="text-sm font-semibold"
              for="clive-stuck-ask">What are you having trouble with?</label
            >
            <p class="text-xs text-base-content/60">
              Say it in your own words. CLive replies with a few lines to think about.
            </p>
            <Textarea
              id="clive-stuck-ask"
              rows={3}
              maxlength={1000}
              placeholder="e.g. I don't know what the program should print when …"
              bind:value={phaseState.stuckDraft}
              disabled={session.busy === 'stuck'}
              oninput={save}
            />
            <div class="flex flex-wrap gap-2">
              <Button
                class="btn-primary"
                type="button"
                disabled={!!session.busy || !session.hasApiKey || !phaseState.stuckDraft.trim()}
                onclick={ask}
              >
                {session.busy === 'stuck' ? 'Thinking…' : 'Ask'}
              </Button>
              <Button
                class="btn-ghost"
                type="button"
                disabled={!!session.busy}
                onclick={() => {
                  phaseState.stuckOpen = false;
                }}>Cancel</Button
              >
            </div>
          </div>
        {:else}
          <Button
            class="btn-ghost w-fit gap-2"
            type="button"
            disabled={!!session.busy || !session.hasApiKey}
            onclick={() => {
              phaseState.stuckOpen = true;
            }}
          >
            <LightbulbIcon class="h-3.5 w-3.5" />
            I'm stuck
          </Button>
        {/if}
      </div>

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
            Phase passed. {nextPhase.label} is open.
            {#if advisoryUnmet}
              {advisoryUnmet} optional point{advisoryUnmet > 1 ? 's' : ''} went unmet — worth a look. Optional points never
              stop you from moving on.
            {/if}
          </span>
        </Alert>
      {/if}

      {#if nudge}
        <div class="flex flex-col gap-3 rounded-box border-l-[3px] border-error bg-base-200 p-5">
          <h3 class="font-display text-base font-bold text-error">Let's look at this one</h3>
          <p class="text-[15.5px]">{nudge.summary}</p>
          {#if focusLine}<p class="text-sm font-medium text-base-content">{focusLine}</p>{/if}
          <p class="max-w-[66ch] text-sm leading-relaxed whitespace-pre-wrap text-base-content/70">{nudge.nudge}</p>
          {#if nudge.failing.length > 1}
            <div class="border-t border-base-content/10 pt-2.5 text-xs text-base-content/60">{MORE_TO_FIX}</div>
          {/if}
        </div>
      {:else if nudgeError}
        <Alert class="alert-warning">
          <TriangleExclamationIcon class="h-4 w-4" />
          <span>Your work was checked, but we could not put together a next step: {nudgeError}</span>
        </Alert>
      {/if}

      {#if latestStuck}
        <div class="flex flex-col gap-3 rounded-box border-l-[3px] border-warning bg-base-200 p-5">
          <h3 class="font-display text-base font-bold text-warning">Something to think about</h3>
          <p class="text-sm text-base-content/70 whitespace-pre-wrap">You said: “{latestStuck.statement}”</p>
          <p class="max-w-[66ch] text-[15.5px] leading-relaxed whitespace-pre-wrap">{latestStuck.feedback}</p>
          {#if olderStuck.length}
            <details class="border-t border-base-content/10 pt-2.5">
              <summary class="cursor-pointer text-sm text-base-content/70">
                Earlier in this phase ({olderStuck.length})
              </summary>
              <div class="mt-2 flex flex-col gap-2.5">
                {#each olderStuck as ask, i (i)}
                  <div class="border-b border-base-content/10 pb-2.5 last:border-b-0">
                    <div class="mb-1 text-xs text-base-content/60 whitespace-pre-wrap">You said: “{ask.statement}”</div>
                    <p class="text-sm leading-relaxed whitespace-pre-wrap text-base-content/70">{ask.feedback}</p>
                  </div>
                {/each}
              </div>
            </details>
          {/if}
        </div>
      {/if}

      {#if verdicts.length || missingIds.length}
        <div class="flex flex-col gap-1 rounded-box border border-base-content/10 bg-base-200 p-5">
          <h3 class="mb-2 font-display text-base font-bold">Every requirement, checked</h3>
          {#each verdicts as v (v.criterion_id)}
            {@const advisory = v.gate === 'advisory'}
            {@const met = v.verdict === 'PASS'}
            {@const badge = badgeFor(v)}
            <div class="flex gap-3 border-t border-base-content/10 py-3 first:border-t-0">
              <Badge class="{badge.class} mt-0.5 min-w-14 shrink-0 justify-center">{badge.text}</Badge>
              <div class="min-w-0 flex-1">
                <div class="text-[14.5px]">
                  {#if v.not_met}
                    <b>{v.not_met}</b>
                    {#if v.explain}{v.explain}{/if}
                  {:else}
                    {v.explain || v.criterion_text || v.criterion_id}
                  {/if}
                </div>
                <div class="mt-0.5 flex flex-wrap items-center gap-2 font-mono text-xs text-base-content/50">
                  <span>{v.criterion_id}</span>
                  <span
                    class="rounded border px-1.5 text-[11px] font-semibold {advisory
                      ? 'border-warning/45 text-warning'
                      : 'border-base-content/20 text-base-content/70'}"
                  >
                    {advisory ? 'optional' : 'required'}
                  </span>
                </div>
                {#if !met && advisory}
                  <div class="mt-1.5 text-sm text-base-content/50 italic">
                    Not met. This one is optional: you can move on without it.
                  </div>
                {/if}
                {#if !met && v.recheck?.length}
                  <div class="mt-1.5 max-w-[64ch] text-sm text-base-content">
                    {v.recheck.join(', ')}: the expected output doesn't match the problem's rule. Trace {v.recheck
                      .length > 1
                      ? 'them'
                      : 'it'} again.
                  </div>
                {/if}
              </div>
            </div>
          {/each}
          {#if missingIds.length}
            <Alert class="alert-warning mt-3.5">
              <TriangleExclamationIcon class="h-4 w-4" />
              <span
                >No ruling came back for: {missingIds.join(', ')}. That is a fault on our side, not yours — submitting
                again usually settles it.</span
              >
            </Alert>
          {/if}
        </div>
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
