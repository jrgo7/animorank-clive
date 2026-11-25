<script lang="ts">
  import type { Snippet } from 'svelte';
  import Alert from '$lib/components/ui/alerts/Alert.svelte';
  import Button from '$lib/components/ui/buttons/Button.svelte';
  import LightbulbIcon from '@iconify-svelte/fa6-solid/lightbulb';
  import { MORE_TO_FIX, type FieldFeedback } from './feedback';

  /**
   * What one question shows after a submit, right under it: "Start here" on the
   * question the nudge is about, "Something to fix here" on another with a
   * required failure, "Worth a look" for a passed submit's optional points. Which
   * one, and its lines, is `fieldFeedback`'s call (`feedback.ts`); this only
   * draws it. Shared by the three stepped phases.
   *
   * The hint ladder lives on the "Start here" card: the hint, then — once the
   * student presses "I'm stuck" — the prompt under it. The button is offered only
   * while the requirement is at hint (`canEscalate`), and goes once it is a prompt.
   */
  let {
    feedback,
    canEscalate = false,
    disabled = false,
    onescalate,
    waiting
  }: {
    feedback: FieldFeedback;
    /** Whether "I'm stuck" is offered: a failed submit, its requirement still at hint. */
    canEscalate?: boolean;
    /** The page is busy, or no model is configured. */
    disabled?: boolean;
    onescalate?: () => void;
    /** Drawn under the card's text while the prompt is on its way. */
    waiting?: Snippet;
  } = $props();
</script>

{#if feedback.kind === 'start'}
  <div class="flex flex-col gap-3 rounded-box border-l-[3px] border-error bg-base-200 p-5">
    <h3 class="font-display text-base font-bold text-error">Start here</h3>
    <p class="text-[15.5px] font-medium">{feedback.lead}</p>
    {#if feedback.check}<p class="text-[15.5px]">{feedback.check}</p>{/if}
    {#if feedback.nudge}
      <p
        class="max-w-[66ch] text-sm leading-relaxed whitespace-pre-wrap text-base-content/70"
        data-nudge-level={feedback.level}
      >
        {feedback.nudge}
      </p>
    {/if}
    {#if feedback.prompt}
      <p
        class="max-w-[66ch] border-l-2 border-base-content/20 pl-3 text-sm leading-relaxed whitespace-pre-wrap"
        data-nudge-level="prompt"
      >
        {feedback.prompt}
      </p>
    {/if}
    {#if waiting}{@render waiting()}{/if}
    {#if feedback.more}
      <div class="border-t border-base-content/10 pt-2.5 text-xs text-base-content/60">{MORE_TO_FIX}</div>
    {/if}
    {#if canEscalate && !waiting}
      <div class="flex flex-wrap items-center gap-2.5 border-t border-base-content/10 pt-2.5">
        <Button
          class="btn-sm gap-2"
          type="button"
          {disabled}
          onclick={() => onescalate?.()}
        >
          <LightbulbIcon class="h-3.5 w-3.5" />
          I'm stuck
        </Button>
      </div>
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
