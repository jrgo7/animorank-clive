<script lang="ts">
  import Alert from '$lib/components/ui/alerts/Alert.svelte';
  import { MORE_TO_FIX, type FieldFeedback } from './feedback';

  /**
   * What one question shows after a submit, right under it: "Start here" on the
   * question the nudge is about, "Something to fix here" on another with a
   * required failure, "Worth a look" for a passed submit's optional points. Which
   * one, and its lines, is `fieldFeedback`'s call (`feedback.ts`); this only
   * draws it. Shared by the three stepped phases.
   */
  let { feedback }: { feedback: FieldFeedback } = $props();
</script>

{#if feedback.kind === 'start'}
  <div class="flex flex-col gap-3 rounded-box border-l-[3px] border-error bg-base-200 p-5">
    <h3 class="font-display text-base font-bold text-error">Start here</h3>
    <p class="text-[15.5px] font-medium">{feedback.lead}</p>
    {#if feedback.check}<p class="text-[15.5px]">{feedback.check}</p>{/if}
    <p class="max-w-[66ch] text-sm leading-relaxed whitespace-pre-wrap text-base-content/70">{feedback.nudge}</p>
    {#if feedback.more}
      <div class="border-t border-base-content/10 pt-2.5 text-xs text-base-content/60">{MORE_TO_FIX}</div>
    {/if}
  </div>
{:else if feedback.kind === 'fix'}
  <div class="flex flex-col gap-2 rounded-box border-l-[3px] border-error bg-base-200 p-5">
    <h3 class="font-display text-base font-bold text-error">Something to fix here</h3>
    <ul class="list-disc pl-5 text-sm leading-relaxed">
      {#each feedback.lines as line, i (i)}<li>{line}</li>{/each}
    </ul>
  </div>
{:else if feedback.kind === 'look'}
  <div class="flex flex-col gap-2 rounded-box border-l-[3px] border-warning bg-base-200 p-5">
    <h3 class="font-display text-base font-bold text-warning">Worth a look</h3>
    <ul class="list-disc pl-5 text-sm leading-relaxed">
      {#each feedback.points as point, i (i)}
        <li>
          {#if point.notMet}<b>{point.notMet}</b>{/if}
          {point.explain}
        </li>
      {/each}
    </ul>
    <div class="border-t border-base-content/10 pt-2.5 text-xs text-base-content/60">
      Optional. You can move on without these.
    </div>
  </div>
{:else}
  <Alert class="alert-success py-2 text-sm"><span>This case passed.</span></Alert>
{/if}
