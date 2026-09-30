<script lang="ts">
  import Badge from '$lib/components/ui/badges/Badge.svelte';
  import Alert from '$lib/components/ui/alerts/Alert.svelte';
  import LightbulbIcon from '@iconify-svelte/fa6-solid/lightbulb';
  import TriangleExclamationIcon from '@iconify-svelte/fa6-solid/triangle-exclamation';
  import type { HintEntry, JudgeResult } from './cliveSession.svelte';

  interface Props {
    isCodePhase: boolean;
    hints: HintEntry[];
    result: JudgeResult | null;
  }

  let { isCodePhase, hints, result }: Props = $props();

  let latestHint = $derived(hints[0]);
  let olderHints = $derived(hints.slice(1));

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
    <h3 class="font-display text-base font-bold text-error">What is holding you here</h3>
    <p class="text-[15.5px]">{n.summary}</p>
    <ul class="flex flex-col border-t border-base-content/10">
      {#each n.failing as f (f.id)}
        {@const focus = f.id === n.focus_id}
        <li class="flex items-baseline gap-2.5 border-b border-base-content/10 py-2">
          <span class="mt-[-1px] h-1.5 w-1.5 shrink-0 rounded-full {focus ? 'bg-error' : 'bg-base-content/20'}"></span>
          <span class="flex-1 text-sm {focus ? 'font-medium text-base-content' : 'text-base-content/70'}">{f.text}</span
          >
          {#if focus}
            <span class="shrink-0 rounded bg-error/15 px-2 py-0.5 text-[11.5px] font-bold text-error whitespace-nowrap"
              >Start here</span
            >
          {/if}
        </li>
      {/each}
    </ul>
    <p class="max-w-[66ch] text-sm leading-relaxed whitespace-pre-wrap text-base-content/70">{n.nudge}</p>
    <div class="border-t border-base-content/10 pt-2.5 text-xs text-base-content/60">
      Why this one first: {n.reason}
    </div>
  </div>
{:else if result?.nudge_error}
  <Alert class="alert-warning">
    <TriangleExclamationIcon class="h-4 w-4" />
    <span>Your work was checked, but we could not put together a next step: {result.nudge_error}</span>
  </Alert>
{/if}

{#if latestHint}
  <div class="flex flex-col gap-3 rounded-box border-l-[3px] border-warning bg-base-200 p-5">
    <h3 class="flex items-center gap-2 font-display text-base font-bold text-warning">
      <LightbulbIcon class="h-4 w-4" />
      {hints.length > 1 ? `A place to think — hint ${hints.length}` : 'A place to think'}
    </h3>
    <p class="text-[15.5px]">{latestHint.diagnosis}</p>
    <p class="max-w-[66ch] text-sm leading-relaxed whitespace-pre-wrap text-base-content/70">{latestHint.hint}</p>
    <div class="border-t border-base-content/10 pt-2.5 text-xs text-base-content/60">
      This is optional depth — {latestHint.criterion_text.replace(/\.$/, '')} — and it is not what is holding you here.{isCodePhase
        ? ' Hints here are about your plan, not C syntax; the C reference above covers that.'
        : ''}
    </div>
    {#if olderHints.length}
      <details class="border-t border-base-content/10 pt-2.5">
        <summary class="cursor-pointer text-sm text-base-content/70"
          >Earlier hints in this phase ({olderHints.length})</summary
        >
        <div class="mt-2 flex flex-col gap-2.5">
          {#each olderHints as h, i (i)}
            <div class="border-b border-base-content/10 pb-2.5 last:border-b-0">
              <div class="mb-1 font-mono text-[11.5px] text-base-content/50">Hint {olderHints.length - i}</div>
              <p class="text-sm leading-relaxed whitespace-pre-wrap text-base-content/70">
                {`${h.diagnosis}\n\n${h.hint}`}
              </p>
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
      {@const badge = badgeFor(v)}
      {@const met = v.verdict === 'PASS'}
      <div class="flex gap-3 border-t border-base-content/10 py-3 first:border-t-0">
        <Badge class="{badge.class} mt-0.5 min-w-14 shrink-0 justify-center">{badge.text}</Badge>
        <div class="min-w-0 flex-1">
          <div class="text-[14.5px]">{v.criterion_text ?? v.criterion_id}</div>
          <div class="mt-0.5 flex flex-wrap items-center gap-2 font-mono text-xs text-base-content/50">
            <span>{v.criterion_id}</span>
            <span
              class="rounded border px-1.5 text-[11px] font-semibold {v.gate === 'advisory'
                ? 'border-warning/45 text-warning'
                : 'border-base-content/20 text-base-content/70'}"
            >
              {v.gate === 'advisory' ? 'advisory' : 'required'}
            </span>
          </div>
          {#if !met && v.gate === 'advisory'}
            <div class="mt-1.5 text-sm text-base-content/50 italic">
              Not met — worth a look, but it did not hold you here.
            </div>
          {/if}
          {#if !met && v.explain}
            <div class="mt-1.5 max-w-[64ch] text-sm text-base-content">{v.explain}</div>
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
