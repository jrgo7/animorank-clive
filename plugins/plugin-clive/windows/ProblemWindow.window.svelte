<script lang="ts">
  import Textarea from '$lib/components/ui/textareas/Textarea.svelte';
  import Button from '$lib/components/ui/buttons/Button.svelte';
  import Alert from '$lib/components/ui/alerts/Alert.svelte';
  import LightbulbIcon from '@iconify-svelte/fa6-solid/lightbulb';
  import ArrowRightIcon from '@iconify-svelte/fa6-solid/arrow-right';
  import TriangleExclamationIcon from '@iconify-svelte/fa6-solid/triangle-exclamation';
  import FieldFeedback from './FieldFeedback.svelte';
  import { cliveSessionFor, type JudgeResult } from './cliveSession.svelte';
  import { PHASES, isFilled } from './phase';
  import { fieldFeedback, fieldMark, startHere } from './feedback';
  import { askStuck, submitPhase, type JudgeContext } from './api';
  import { CLIVE_EVENT } from './telemetry';
  import type { SolveWindowContext } from '../../../src/routes/problem/[problem_id]/[session_id]/context.svelte';

  // `phaseIndex` is fixed per window file rather than taken as a prop: `Window`
  // types its mounted component as `Component<{ context: T }>` (see
  // `$lib/window/index.ts`), so a required extra prop here would fail that type
  // even though `options.props` does forward it at runtime.
  let { context }: { context: SolveWindowContext } = $props();

  /**
   * Phase 1 of PCDIT, `problem_definition`: the statement once, then one question
   * at a time. Every word the student reads is here rather than in `phase.ts`,
   * which keeps only what the server contract needs (the phase id, its label, its
   * field ids and kinds). The phase and field *labels* stay shared: the client
   * sends them to the judge as `prior_artifacts`, and the nudge and stuck prompts
   * render them.
   */
  const config = PHASES[0];
  /** The phase after this one, for the "Phase passed" line and the way on. */
  const nextPhase = PHASES[1];

  /** The sample problem each question's example answers, shown above the example. */
  const EXAMPLE_PROBLEM =
    'Read the length and width of a rectangle, each a whole number of centimeters from 1 to\n100. Print the area.';

  const SUMMARY_QUESTION =
    'When solving a problem, the very first thing you should do is understand it. In your own words, what is the program supposed to do?';
  const SUMMARY_HINT = "One or two sentences is enough, as if explaining to a classmate who hasn't read the problem.";
  const SUMMARY_EXAMPLE = "The program asks for a rectangle's length and width and prints its area.";

  const INPUTS_QUESTION = 'Next, state what the program is given. What values does it read?';
  const INPUTS_HINT =
    'List each value in the order the program reads it. Give each a C type (int, float, double or char) and any limits the problem gives, like "between 1 and 100". If the problem gives no limits, say so.';
  const INPUTS_EXAMPLE =
    '1. length: an int from 1 to 100.\n2. width: an int from 1 to 100.\nLength is read first, then width.';

  const OUTPUTS_QUESTION = 'Then state what it must print. What should the program display?';
  const OUTPUTS_HINT =
    'If it prints a single value, give its C type (int, float, double or char). Say exactly what it looks like: how many decimal places, any words around the number (such as Age: ), in one line or several. If it prints text or a pattern of several values, describing exactly how it looks is enough.';
  const OUTPUTS_EXAMPLE = 'The area as an int, for example, 24.';

  let session = $derived(cliveSessionFor(context));
  let phaseState = $derived(session.phases[0]);
  let fields = $derived(session.inPlay(0));

  /** The question on screen, clamped so a stale saved step can never throw. */
  let openIndex = $derived(Math.max(0, Math.min(phaseState.step || 0, fields.length - 1)));
  let openField = $derived(fields[openIndex]);

  let current = $derived(session.stateFor(0, openField.id));

  /** Whether any of the three answers is still empty: Submit waits for all of them. */
  const blank = $derived(fields.some((f) => !isFilled(phaseState.artifact[f.id])));

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

  // What the judge's reply has to show, one thing at a time and on the question it
  // is about (see `feedback.ts`): the question on screen shows its own part of the
  // result, and no list of every requirement is put in front of the student.
  const feedback = $derived(fieldFeedback(current.result, openField.id, false));
  const nudgeError = $derived(current.result?.nudge_error);
  /** A requirement the judge never ruled on belongs to no question, so it is said once, above them. */
  const missingIds = $derived(current.result?.missing_ids ?? []);
  const latestStuck = $derived(phaseState.stuck[0]);
  const olderStuck = $derived(phaseState.stuck.slice(1));

  function save(): void {
    session.persist();
  }

  /** Move to another of the three questions, remembering it for a reload. */
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
        priorArtifacts: session.priorArtifacts(0),
        statement,
        // Three fields, so there is no one field the student is on.
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

  function startQuestions(): void {
    phaseState.read = true;
    context.telemetry.record(CLIVE_EVENT.problemRead, { phase: config.phase });
    save();
  }

  async function submit(): Promise<void> {
    session.busy = 'submit';
    session.busySince = Date.now();
    session.error = null;
    // Read before the call: a failing attempt increments it below, and the attempt
    // being submitted is the one the student made.
    const attempt = current.attempt;
    try {
      const payload: JudgeContext = {
        sessionId: context.practiceSession.id,
        phase: config.phase,
        problemId: context.problem.id,
        artifact: phaseState.artifact,
        attempt,
        priorArtifacts: session.priorArtifacts(0)
      };
      const result: JudgeResult = await submitPhase(payload);
      session.recordResult(0, result);
      // A failed submit opens on the question its feedback starts from.
      if (!result.passed) {
        phaseState.step = startHere(
          result,
          fields.map((f) => f.id),
          openIndex
        );
      }
    } catch (e) {
      session.error = e instanceof Error ? e.message : String(e);
    } finally {
      session.busy = null;
      session.busySince = null;
      save();
    }
  }

  function continueToNext(): void {
    session.open(1);
    context.telemetry.record(CLIVE_EVENT.phaseOpen, { phase: nextPhase.phase, via: 'continue' });
    context.openWindow(`clive:${nextPhase.phase}`);
  }
</script>

<div class="h-full min-w-0 overflow-y-auto">
  <!-- A submit waits where its feedback will go, in place of the last one; a stuck ask
       waits under its own box. -->
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
  {:else if !phaseState.read}
    <div class="flex flex-col gap-5 p-5 pb-10">
      {#if session.error}
        <Alert class="alert-error"><span>{session.error}</span></Alert>
      {/if}

      <div class="flex flex-wrap items-center justify-between gap-4">
        <p class="max-w-[54ch] text-sm text-base-content/70">
          Read the problem in the Problem Info tab and take your time with it. Press Next when you know what it asks.
        </p>
        <Button
          class="btn-primary gap-2"
          type="button"
          onclick={startQuestions}
        >
          Next
          <ArrowRightIcon class="h-3 w-3" />
        </Button>
      </div>
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
          <span>You can keep improving this and submit again. It stays passed either way.</span>
        </Alert>
      {/if}

      <p class="max-w-[68ch] border-l-2 border-primary py-0.5 pl-4 text-sm leading-relaxed text-base-content/70">
        Every solution starts with understanding the problem. Before you think about code, make sure you know exactly
        what it asks.
      </p>

      <div class="flex flex-col gap-5">
        {#if openField.id === 'summary'}
          <div class="flex flex-col gap-1.5">
            <span class="text-sm font-semibold">{SUMMARY_QUESTION}</span>
            <span class="text-xs text-base-content/60">{SUMMARY_HINT}</span>
            <details class="text-xs">
              <summary class="w-fit cursor-pointer font-medium text-primary">Show an example</summary>
              <p class="mt-1.5 text-xs text-base-content/70">{EXAMPLE_PROBLEM}</p>
              <pre
                class="mt-1.5 whitespace-pre-wrap rounded-lg bg-base-200 p-3 text-[13px] text-base-content/70">{SUMMARY_EXAMPLE}</pre>
            </details>
            <Textarea
              rows={4}
              bind:value={(phaseState.artifact as Record<string, string>).summary}
              disabled={!!session.busy}
              oninput={save}
            />
          </div>
        {:else if openField.id === 'inputs'}
          <div class="flex flex-col gap-1.5">
            <span class="text-sm font-semibold">{INPUTS_QUESTION}</span>
            <span class="text-xs text-base-content/60">{INPUTS_HINT}</span>
            <details class="text-xs">
              <summary class="w-fit cursor-pointer font-medium text-primary">Show an example</summary>
              <p class="mt-1.5 text-xs text-base-content/70">{EXAMPLE_PROBLEM}</p>
              <pre
                class="mt-1.5 whitespace-pre-wrap rounded-lg bg-base-200 p-3 text-[13px] text-base-content/70">{INPUTS_EXAMPLE}</pre>
            </details>
            <Textarea
              rows={4}
              bind:value={(phaseState.artifact as Record<string, string>).inputs}
              disabled={!!session.busy}
              oninput={save}
            />
          </div>
        {:else}
          <div class="flex flex-col gap-1.5">
            <span class="text-sm font-semibold">{OUTPUTS_QUESTION}</span>
            <span class="text-xs text-base-content/60">{OUTPUTS_HINT}</span>
            <details class="text-xs">
              <summary class="w-fit cursor-pointer font-medium text-primary">Show an example</summary>
              <p class="mt-1.5 text-xs text-base-content/70">{EXAMPLE_PROBLEM}</p>
              <pre
                class="mt-1.5 whitespace-pre-wrap rounded-lg bg-base-200 p-3 text-[13px] text-base-content/70">{OUTPUTS_EXAMPLE}</pre>
            </details>
            <Textarea
              rows={3}
              bind:value={(phaseState.artifact as Record<string, string>).outputs}
              disabled={!!session.busy}
              oninput={save}
            />
          </div>
        {/if}
      </div>

      {#if session.busy === 'submit'}
        {@render thinking()}
      {:else if feedback}
        <FieldFeedback {feedback} />
      {/if}

      {#if fields.length > 1}
        <div class="flex flex-wrap gap-1.5">
          {#each fields as field, j (field.id)}
            {@const mark = fieldMark(session.stateFor(0, field.id).result, field.id)}
            {@const here = j === openIndex}
            {@const open = session.stepOpen(0, j)}
            <!-- The number says how the question did on the last submit: red while a
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

      <!-- "What are you stuck on?": the student says what they find hard, in their own
           words, and gets a few lines back. The only help on the page since 2026-10-10. -->
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
      {/if}

      <div class="flex flex-wrap items-center gap-2.5">
        {#if openIndex === fields.length - 1 || phaseState.attempt > 1}
          <!-- After a pass the way on leads and this steps back: a still-primary Submit
               reads as the thing to click when the student means to move on. -->
          <Button
            class={phaseState.passed ? 'btn-ghost' : 'btn-primary'}
            type="button"
            disabled={!!session.busy || blank}
            onclick={submit}
          >
            {session.busy === 'submit' ? 'Checking…' : phaseState.passed || current.attempt > 1 ? 'Resubmit' : 'Submit'}
          </Button>
        {:else}
          <Button
            class="btn-ghost gap-2"
            type="button"
            disabled={!!session.busy}
            onclick={() => goStep(openIndex + 1)}
          >
            Next: {fields[openIndex + 1].label}
            <ArrowRightIcon class="h-3 w-3" />
          </Button>
        {/if}
        {#if !(phaseState.stuckOpen || session.busy === 'stuck')}
          <Button
            class="btn-ghost gap-2"
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

      {#if session.busy === 'stuck'}
        {@render thinking()}
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

      {#if nudgeError}
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

      {#if phaseState.passed && session.phases[1]?.unlocked && !session.busy}
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
    </div>
  {/if}
</div>
