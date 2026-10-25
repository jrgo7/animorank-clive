<script lang="ts">
  import Textarea from '$lib/components/ui/textareas/Textarea.svelte';
  import Button from '$lib/components/ui/buttons/Button.svelte';
  import Alert from '$lib/components/ui/alerts/Alert.svelte';
  import Badge from '$lib/components/ui/badges/Badge.svelte';
  import Checkbox from '$lib/components/ui/checkboxes/Checkbox.svelte';
  import LightbulbIcon from '@iconify-svelte/fa6-solid/lightbulb';
  import TriangleExclamationIcon from '@iconify-svelte/fa6-solid/triangle-exclamation';
  import { cliveSessionFor, type JudgeResult } from './cliveSession.svelte';
  import { PHASES } from './phase';
  import { MORE_TO_FIX } from './feedback';
  import { askStuck, submitPhase, type JudgeContext } from './api';
  import { live } from './live.svelte';
  import type { SolveWindowContext } from '../../../src/routes/problem/[problem_id]/[session_id]/context.svelte';

  // `phaseIndex` is fixed per window file rather than taken as a prop: `Window`
  // types its mounted component as `Component<{ context: T }>` (see
  // `$lib/window/index.ts`), so a required extra prop here would fail that type
  // even though `options.props` does forward it at runtime.
  let { context }: { context: SolveWindowContext } = $props();

  /**
   * Phase 4 of PCDIT, `implement`: the last phase, and the only one whose field
   * this window does not edit. The student writes the C in AnimoRank's own Code
   * Editor window; Run and Submit there check it against the examples and the
   * hidden cases, and this window's one button asks the plan-vs-code judge to
   * compare the code that passed against what the student wrote in Cases and
   * Design. Every word the student reads is here rather than in `phase.ts`.
   */
  const config = PHASES[3];

  /** The one field this phase has: the code, which lives in the Code Editor window. */
  const codeField = config.artifactFields[0];

  /** Where the code actually lives, and what checks it. */
  const CODE_NOTE =
    'Edited in the Code Editor window. Run and Submit there check it against the examples and the hidden cases; ' +
    '"Check against your plan" below compares the code that passes against what you wrote in Cases and Design.';

  /** clangd marks compile problems in the Code Editor while the student types; this is the box. */
  const LIVE_BOX = "Show the compiler's own words";

  let session = $derived(cliveSessionFor(context));
  let phaseState = $derived(session.phases[3]);

  let current = $derived(session.stateFor(3, 'code'));

  // The gate isn't "did you write something" -- AnimoRank's own Code Editor window
  // owns that field. It's "has the code already passed AnimoRank's own tests",
  // since a failing submission there is AnimoRank's Submit flow to nudge, not this
  // plugin's.
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
        ? `${session.busy === 'stuck' ? 'An answer' : 'Checking'} can take up to a minute. Your work is saved, so please don't reload.`
        : ''
  );

  const badgeFor = (v: JudgeResult['verdicts'][number]) =>
    v.verdict === 'PASS'
      ? { class: 'badge-success', text: 'Met' }
      : v.gate === 'advisory'
        ? { class: 'badge-warning', text: 'Optional' }
        : { class: 'badge-error', text: 'Not met' };

  // What the judge's reply has to show, read out of the result the phase currently
  // holds. Derived here rather than inline in the markup, so each block reads as the
  // one thing it renders.
  const nudge = $derived(current.result?.nudge);
  /** The one requirement the nudge is about; the others wait for the next check. */
  const focus = $derived.by(() => {
    const n = nudge;
    return n ? (n.failing.find((f) => f.id === n.focus_id) ?? n.failing[0]) : undefined;
  });
  const nudgeError = $derived(current.result?.nudge_error);
  const verdicts = $derived(current.result?.verdicts ?? []);
  const missingIds = $derived(current.result?.missing_ids ?? []);
  const latestCode = $derived(phaseState.codeFeedback[0]);
  const olderCode = $derived(phaseState.codeFeedback.slice(1));
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
        priorArtifacts: session.priorArtifacts(3),
        statement,
        // The phase shows exactly one field, so this is the field the student is on.
        fieldId: 'code',
        history,
        code: context.editorState.code
      });
      phaseState.stuck.unshift({ statement, feedback: got.feedback, fieldId: 'code', attempt: current.attempt });
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
        priorArtifacts: session.priorArtifacts(3),
        code: context.editorState.code
      };
      const result: JudgeResult = await submitPhase(payload);
      session.recordResult(3, result);
    } catch (e) {
      session.error = e instanceof Error ? e.message : String(e);
    } finally {
      session.busy = null;
      session.busySince = null;
      save();
    }
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

      <p class="max-w-[68ch] border-l-2 border-primary py-0.5 pl-4 text-sm leading-relaxed text-base-content/70">
        Now translate your plan into C, one step at a time. Your design is beside your code. Press Run to test it on the
        examples. Press Submit when it works for a final check against test cases you haven't seen. Print only what the
        problem asks for, with no extra messages like "Enter a number:". Don't use AI tools like ChatGPT.
      </p>

      <!-- The code field has no editor of its own: the student writes it next door, in
           AnimoRank's Code Editor window, and this window only says so and adds the
           plan-vs-code judge below. -->
      <div class="flex flex-col gap-1.5">
        <span class="text-sm font-semibold">{codeField.label}</span>
        <span class="text-xs text-base-content/60">Write your whole program here.</span>

        <div
          class="rounded-lg border border-dashed border-base-content/20 bg-base-200 px-3 py-2.5 text-sm text-base-content/60"
        >
          {CODE_NOTE}
        </div>

        <!-- Live checking: a note while clangd is still loading, and the box that shows
             the compiler's own words. Nothing at all when it is off, unavailable on this
             machine, or dead (see `live.svelte.ts`). -->
        {#if live.mode === 'on' && !live.dead}
          <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-base-content/50">
            {#if !live.ready}
              <span>Checking as you type will start in a moment.</span>
            {/if}
            <Checkbox
              class="checkbox-xs"
              labelClass="gap-1.5 text-xs"
              checked={live.raw}
              onchange={(event) => live.setRaw(event.currentTarget.checked)}
            >
              {LIVE_BOX}
            </Checkbox>
          </div>
        {/if}
      </div>

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
        <Button
          class="btn-primary"
          type="button"
          disabled={!!session.busy || !canCheckImplementation}
          onclick={submit}
        >
          {session.busy === 'submit' ? 'Checking…' : 'Check against your plan'}
        </Button>
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
        {#if !canCheckImplementation}
          <span class="font-mono text-xs text-base-content/50">Pass Submit in the Code Editor window first</span>
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

      {#if session.codeFeedbackBusy}
        <div
          class="flex items-center gap-2.5 rounded-box border border-base-content/10 bg-base-200 p-4 text-sm text-base-content/70"
          role="status"
        >
          <span class="h-2 w-2 shrink-0 animate-pulse rounded-full bg-primary"></span>
          <span>CLive is looking at your code…</span>
        </div>
      {:else if latestCode}
        <div class="flex flex-col gap-2 rounded-box border-l-[3px] border-warning bg-base-200 p-5">
          <h3 class="font-display text-base font-bold text-warning">
            About your last {latestCode.runType === 'submit' ? 'Submit' : 'Run'}
          </h3>
          {#each latestCode.nudge.split('\n').filter((line) => line.trim()) as line, i (i)}
            <p
              class="max-w-[66ch] text-[15px] leading-relaxed"
              data-code-feedback-line
            >
              {line}
            </p>
          {/each}
          {#if olderCode.length}
            <details class="border-t border-base-content/10 pt-2.5">
              <summary class="cursor-pointer text-sm text-base-content/70">Earlier ({olderCode.length})</summary>
              <div class="mt-2 flex flex-col gap-2.5">
                {#each olderCode as entry, i (i)}
                  <p class="text-sm leading-relaxed whitespace-pre-line text-base-content/70">{entry.nudge}</p>
                {/each}
              </div>
            </details>
          {/if}
        </div>
      {/if}

      {#if phaseState.passed}
        {@const advisoryUnmet = current.result?.advisory_unmet.length ?? 0}
        <Alert class="alert-success">
          <span>
            Phase passed. That was the last one.
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
          {#if focus}
            <ul class="list-disc pl-5 text-sm font-medium text-base-content">
              <li>{focus.text}</li>
            </ul>
          {/if}
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
          <!-- This phase's code is the student's own; the advisory judge reads the plan. -->
          <div class="text-xs text-base-content/60">
            This is about your plan, not C syntax; the C reference above covers that.
          </div>
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
        <!-- Folded: the full list is there for a student who wants it, not put in front of them. -->
        <details class="flex flex-col gap-1 rounded-box border border-base-content/10 bg-base-200 p-5">
          <summary class="cursor-pointer font-display text-base font-bold">See every requirement</summary>
          {#each verdicts as v (v.criterion_id)}
            {@const advisory = v.gate === 'advisory'}
            {@const met = v.verdict === 'PASS'}
            {@const badge = badgeFor(v)}
            <div class="flex gap-3 border-t border-base-content/10 py-3 first-of-type:mt-2">
              <Badge class="{badge.class} mt-0.5 min-w-14 shrink-0 justify-center">{badge.text}</Badge>
              <div class="min-w-0 flex-1">
                <div class="text-[14.5px]">{v.criterion_text || v.criterion_id}</div>
                <div class="mt-0.5 flex flex-wrap items-center gap-2 font-mono text-xs text-base-content/50">
                  <span
                    class="rounded border px-1.5 text-[11px] font-semibold {advisory
                      ? 'border-warning/45 text-warning'
                      : 'border-base-content/20 text-base-content/70'}"
                  >
                    {advisory ? 'optional' : 'required'}
                  </span>
                </div>
                {#if !met && advisory}
                  <!-- The team's direct line first, as on the stepped phases' "Worth a look". -->
                  {#if v.not_met}<div class="mt-1.5 max-w-[64ch] text-sm text-base-content">{v.not_met}</div>{/if}
                  <div class="mt-1.5 text-sm text-base-content/50 italic">
                    Not met. This one is optional: you can move on without it.
                  </div>
                {/if}
                {#if !met && v.explain}
                  <div class="mt-1.5 max-w-[64ch] text-sm text-base-content">{v.explain}</div>
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
        </details>
      {/if}

      {#if phaseState.passed}
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
