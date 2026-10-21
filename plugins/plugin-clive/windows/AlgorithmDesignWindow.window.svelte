<script lang="ts">
  import { tick } from 'svelte';
  import Textarea from '$lib/components/ui/textareas/Textarea.svelte';
  import Button from '$lib/components/ui/buttons/Button.svelte';
  import Alert from '$lib/components/ui/alerts/Alert.svelte';
  import Badge from '$lib/components/ui/badges/Badge.svelte';
  import LightbulbIcon from '@iconify-svelte/fa6-solid/lightbulb';
  import ArrowRightIcon from '@iconify-svelte/fa6-solid/arrow-right';
  import TriangleExclamationIcon from '@iconify-svelte/fa6-solid/triangle-exclamation';
  import ProblemDescription from '$lib/components/content/ProblemDescription.svelte';
  import { cliveSessionFor, type JudgeResult } from './cliveSession.svelte';
  import {
    PHASES,
    STEP_LEVELS,
    isFilled,
    markersFor,
    normaliseOutline,
    outlineText,
    parseOutline,
    type OutlineRow
  } from './phase';
  import { askStuck, submitPhase, type JudgeContext } from './api';
  import { CLIVE_EVENT } from './telemetry';
  import type { SolveWindowContext } from '../../../src/routes/problem/[problem_id]/[session_id]/context.svelte';

  // `phaseIndex` is fixed per window file rather than taken as a prop: `Window`
  // types its mounted component as `Component<{ context: T }>` (see
  // `$lib/window/index.ts`), so a required extra prop here would fail that type
  // even though `options.props` does forward it at runtime.
  let { context }: { context: SolveWindowContext } = $props();

  /**
   * Phase 3 of PCDIT, `algorithm_design`: what the student did by hand, written as
   * an ordered outline. Every word the student reads is here rather than in
   * `phase.ts`, which keeps only what the server contract needs (the phase id, its
   * label, and the `steps` field itself, since that is the artifact key the judge
   * reads). The editor below is this window's own: Enter makes a step, Tab nests it,
   * and every change is saved as it is made.
   */
  const config = PHASES[2];
  /** The phase after this one, for the "Phase passed" line and the way on. */
  const nextPhase = PHASES[3];

  /** The sample problem the example answers, shown above it. */
  const EXAMPLE_PROBLEM = 'Read a whole number n, which is 1 or more. Print the sum 1 + 2 + ... + n.';

  const QUESTION =
    'Look back at how you worked out your cases. What did you do, step by step? Write it so anyone could follow it.';
  const HINT = 'Place one action per step. You may use indentation to express conditional or repeating statements.';

  /** The worked outline the example shows, numbered and indented the way the editor does. */
  const EXAMPLE_ROWS: OutlineRow[] = [
    { text: 'Read n.', level: 0 },
    { text: 'Set the total to 0 and the counter to 1.', level: 0 },
    { text: 'While the counter is at most n:', level: 0 },
    { text: 'Add the counter to the total.', level: 1 },
    { text: 'Add 1 to the counter.', level: 1 },
    { text: 'Print the total.', level: 0 }
  ];
  const EXAMPLE_TEXT = outlineText(EXAMPLE_ROWS);

  let session = $derived(cliveSessionFor(context));
  let phaseState = $derived(session.phases[2]);

  /** The outline the student is writing: this phase's one field, `steps`. */
  let rows = $derived(phaseState.artifact.steps as OutlineRow[]);

  let current = $derived(session.stateFor(2, 'steps'));

  /** Whether the outline holds anything yet: Submit waits for a step. */
  const blank = $derived(!isFilled(phaseState.artifact.steps));

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

  // What the judge's reply has to show, read out of the result the phase currently
  // holds. Derived here rather than inline in the markup, so each block reads as the
  // one thing it renders.
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
        priorArtifacts: session.priorArtifacts(2),
        statement,
        // The phase shows exactly one field, so this is the field the student is on.
        fieldId: 'steps',
        history
      });
      phaseState.stuck.unshift({ statement, feedback: got.feedback, fieldId: 'steps', attempt: current.attempt });
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
        priorArtifacts: session.priorArtifacts(2)
      };
      const result: JudgeResult = await submitPhase(payload);
      session.recordResult(2, result);
    } catch (e) {
      session.error = e instanceof Error ? e.message : String(e);
    } finally {
      session.busy = null;
      session.busySince = null;
      save();
    }
  }

  function continueToNext(): void {
    session.open(3);
    context.telemetry.record(CLIVE_EVENT.phaseOpen, { phase: nextPhase.phase, via: 'continue' });
    context.openWindow(`clive:${nextPhase.phase}`);
  }

  // The outline editor. One auto-growing box per row, its marker from `markersFor`,
  // indented by its level: Enter makes the next step, Tab and Shift+Tab move it in
  // and out, and the arrow keys and Backspace do what a document's do. Rows are
  // mutated in place, which the artifact's own `$state` already tracks.
  let areas: (HTMLTextAreaElement | undefined)[] = [];

  const marks = $derived(markersFor(rows));

  // Keep every row's height hugging its text after a structural change or mount.
  $effect(() => {
    void rows.length;
    void tick().then(() => {
      for (const el of areas) if (el) grow(el);
    });
  });

  function grow(el: HTMLTextAreaElement): void {
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }

  /** Move focus (and the caret) once the DOM has caught up with a structural change. */
  async function focusStep(index: number, caret = 0): Promise<void> {
    await tick();
    const el = areas[index];
    if (!el) return;
    el.focus();
    el.setSelectionRange(caret, caret);
    grow(el);
  }

  function changed(): void {
    normaliseOutline(rows);
    save();
  }

  function indent(i: number): void {
    if (i > 0 && rows[i].level < Math.min(rows[i - 1].level + 1, STEP_LEVELS - 1)) rows[i].level += 1;
    changed();
    void focusStep(i, areas[i]?.selectionStart ?? 0);
  }

  function outdent(i: number): void {
    if (rows[i].level > 0) rows[i].level -= 1;
    changed();
    void focusStep(i, areas[i]?.selectionStart ?? 0);
  }

  function keydown(event: KeyboardEvent, i: number): void {
    const el = event.currentTarget as HTMLTextAreaElement;
    const at = el.selectionStart;
    const end = el.selectionEnd;
    if (event.key === 'Enter') {
      event.preventDefault();
      const rest = rows[i].text.slice(end);
      rows[i].text = rows[i].text.slice(0, at);
      rows.splice(i + 1, 0, { text: rest, level: rows[i].level });
      changed();
      void focusStep(i + 1, 0);
    } else if (event.key === 'Tab') {
      event.preventDefault();
      (event.shiftKey ? outdent : indent)(i);
    } else if (event.key === 'Backspace' && !rows[i].text && rows.length > 1) {
      event.preventDefault();
      rows.splice(i, 1);
      changed();
      void focusStep(Math.max(0, i - 1));
    } else if (event.key === 'Backspace' && at === 0 && end === 0 && rows[i].level > 0) {
      // At the start of a nested step, Backspace un-nests it first, as a document does.
      event.preventDefault();
      outdent(i);
    } else if (event.key === 'Backspace' && at === 0 && end === 0 && i > 0) {
      // ...and at the start of a top-level step it joins it onto the step before, so an
      // Enter pressed mid-sentence can be undone.
      event.preventDefault();
      const join = rows[i - 1].text.length;
      rows[i - 1].text += rows[i].text;
      rows.splice(i, 1);
      changed();
      void focusStep(i - 1, join);
    } else if (event.key === 'ArrowUp' && at === 0 && end === 0 && i > 0) {
      event.preventDefault();
      void focusStep(i - 1);
    } else if (event.key === 'ArrowDown' && at === el.value.length && i < rows.length - 1) {
      event.preventDefault();
      void focusStep(i + 1, 0);
    }
  }

  /** Several lines pasted at once become steps: indentation sets the nesting, markers go. */
  function paste(event: ClipboardEvent, i: number): void {
    const text = event.clipboardData?.getData('text') ?? '';
    if (!/\n/.test(text)) return;
    const parsed = parseOutline(text);
    if (!parsed.length) return;
    event.preventDefault();
    const el = event.currentTarget as HTMLTextAreaElement;
    const before = rows[i].text.slice(0, el.selectionStart);
    const after = rows[i].text.slice(el.selectionEnd);
    const base = rows[i].level;
    const [first, ...rest] = parsed;
    rows[i].text = before + first.text;
    const added = rest.map((row) => ({ text: row.text, level: base + row.level }));
    if (added.length) added[added.length - 1].text += after;
    else rows[i].text += after;
    rows.splice(i + 1, 0, ...added);
    changed();
    void focusStep(i + added.length, 0);
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
        Now turn what you did by hand into steps. Plan in plain English first; the C comes after.
      </p>

      {@render statement(false)}

      <div class="flex flex-col gap-1.5">
        <span class="text-sm font-semibold">{QUESTION}</span>
        <span class="text-xs text-base-content/60">{HINT}</span>

        <details class="text-xs">
          <summary class="w-fit cursor-pointer font-medium text-primary">Show an example</summary>
          <p class="mt-1.5 text-xs text-base-content/70">{EXAMPLE_PROBLEM}</p>
          <pre
            class="mt-1.5 whitespace-pre-wrap rounded-lg bg-base-200 p-3 text-[13px] text-base-content/70">{EXAMPLE_TEXT}</pre>
        </details>

        <div class="flex flex-col gap-1.5">
          <div class="rounded-lg border border-base-content/15 bg-base-200 px-1.5 py-2 focus-within:border-primary">
            {#each rows as row, i (i)}
              <div
                class="flex items-start gap-1"
                style="padding-left: {row.level * 1.6}em"
              >
                <span class="mt-2 w-4 shrink-0 text-right font-mono text-xs text-base-content/50">{marks[i]}</span>
                <textarea
                  bind:this={areas[i]}
                  rows="1"
                  class="field-sizing-content min-h-0 w-full resize-none border-0 bg-transparent py-1 text-sm leading-snug outline-none"
                  aria-label={`Step ${marks[i]}`}
                  readonly={!!session.busy}
                  value={row.text}
                  oninput={(e) => {
                    row.text = (e.currentTarget as HTMLTextAreaElement).value.replace(/\n/g, ' ');
                    grow(e.currentTarget as HTMLTextAreaElement);
                    save();
                  }}
                  onkeydown={(e) => keydown(e, i)}
                  onpaste={(e) => paste(e, i)}
                ></textarea>
                <span class="flex shrink-0 items-center">
                  <button
                    type="button"
                    class="btn btn-ghost btn-xs px-1 text-base-content/60"
                    title="Outdent (Shift+Tab)"
                    aria-label="Outdent step"
                    disabled={!!session.busy}
                    onmousedown={(e) => e.preventDefault()}
                    onclick={() => outdent(i)}>⇤</button
                  >
                  <button
                    type="button"
                    class="btn btn-ghost btn-xs px-1 text-base-content/60"
                    title="Indent (Tab)"
                    aria-label="Indent step"
                    disabled={!!session.busy}
                    onmousedown={(e) => e.preventDefault()}
                    onclick={() => indent(i)}>⇥</button
                  >
                </span>
              </div>
            {/each}
          </div>
          <div class="text-xs text-base-content/60">Enter: new step · Tab: indent · Shift+Tab: outdent</div>
        </div>
      </div>

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
          disabled={!!session.busy || blank}
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

      {#if phaseState.passed && session.phases[3]?.unlocked && !session.busy}
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
