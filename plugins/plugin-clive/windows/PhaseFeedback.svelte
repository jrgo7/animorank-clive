<script lang="ts">
  import Badge from '$lib/components/ui/badges/Badge.svelte';
  import Alert from '$lib/components/ui/alerts/Alert.svelte';
  import TriangleExclamationIcon from '@iconify-svelte/fa6-solid/triangle-exclamation';
  import type { JudgeResult, StuckEntry } from './cliveSession.svelte';

  interface Props {
    isCodePhase: boolean;
    stuck: StuckEntry[];
    result: JudgeResult | null;
  }

  let { isCodePhase, stuck, result }: Props = $props();

  /** One failure shown at a time, with a line saying the rest will be checked again. */
  const MORE_TO_FIX = "There may be other things to fix. Submit again once this one's done and I'll check.";

  /** The requirement line, read as something to do: `Check this: …`. */
  const notYet = (text: string) =>
    `Check this: ${/^[A-Z][a-z]/.test(text || '') ? text[0].toLowerCase() + text.slice(1) : text || ''}`;

  let latestStuck = $derived(stuck[0]);
  let olderStuck = $derived(stuck.slice(1));

  /** The one requirement the nudge is about, and the line above it that says what to do. */
  let focus = $derived(
    result?.nudge
      ? (result.nudge.failing.find((f) => f.id === result.nudge?.focus_id) ?? result.nudge.failing[0])
      : undefined
  );
  let focusLine = $derived(result?.nudge ? result.nudge.focus_not_met || notYet(focus?.text ?? '') : '');

  const badgeFor = (v: JudgeResult['verdicts'][number]) =>
    v.verdict === 'PASS'
      ? { class: 'badge-success', text: 'Met' }
      : v.gate === 'advisory'
        ? { class: 'badge-warning', text: 'Depth' }
        : { class: 'badge-error', text: 'Blocks' };
</script>

{#if result?.nudge}
  {@const n = result.nudge}
  <div class="flex flex-col gap-3 rounded-box border-l-[3px] border-error bg-base-200 p-5">
    <h3 class="font-display text-base font-bold text-error">Let's look at this one</h3>
    <p class="text-[15.5px]">{n.summary}</p>
    {#if focusLine}<p class="text-sm font-medium text-base-content">{focusLine}</p>{/if}
    <p class="max-w-[66ch] text-sm leading-relaxed whitespace-pre-wrap text-base-content/70">{n.nudge}</p>
    {#if n.failing.length > 1}
      <div class="border-t border-base-content/10 pt-2.5 text-xs text-base-content/60">{MORE_TO_FIX}</div>
    {/if}
  </div>
{:else if result?.nudge_error}
  <Alert class="alert-warning">
    <TriangleExclamationIcon class="h-4 w-4" />
    <span>Your work was checked, but we could not put together a next step: {result.nudge_error}</span>
  </Alert>
{/if}

{#if latestStuck}
  <div class="flex flex-col gap-3 rounded-box border-l-[3px] border-warning bg-base-200 p-5">
    <h3 class="font-display text-base font-bold text-warning">Something to think about</h3>
    <p class="text-sm text-base-content/70 whitespace-pre-wrap">You said: “{latestStuck.statement}”</p>
    <p class="max-w-[66ch] text-[15.5px] leading-relaxed whitespace-pre-wrap">{latestStuck.feedback}</p>
    {#if isCodePhase}
      <div class="text-xs text-base-content/60">
        This is about your plan, not C syntax; the C reference above covers that.
      </div>
    {/if}
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

{#if result && (result.verdicts.length || result.missing_ids.length)}
  <div class="flex flex-col gap-1 rounded-box border border-base-content/10 bg-base-200 p-5">
    <h3 class="mb-2 font-display text-base font-bold">Every requirement, checked</h3>
    {#each result.verdicts as v (v.criterion_id)}
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
              {v.recheck.join(', ')}: the expected output doesn't match the problem's rule. Trace {v.recheck.length > 1
                ? 'them'
                : 'it'} again.
            </div>
          {/if}
        </div>
      </div>
    {/each}
    {#if result.missing_ids.length}
      <Alert class="alert-warning mt-3.5">
        <TriangleExclamationIcon class="h-4 w-4" />
        <span
          >No ruling came back for: {result.missing_ids.join(', ')}. That is a fault on our side, not yours — submitting
          again usually settles it.</span
        >
      </Alert>
    {/if}
  </div>
{/if}
