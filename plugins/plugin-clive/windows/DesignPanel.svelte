<script lang="ts">
  import Button from '$lib/components/ui/buttons/Button.svelte';
  import { markersFor, type OutlineRow } from './phase';

  /**
   * The student's own Design, read-only, inside Implement: the plan they are
   * coding from, beside the code editor. Ported from the prototype's
   * `renderDesignPane`; round 6 participants relied on it ("I just copied the
   * formulas from my design"), and one could not find the Design without it.
   */
  let { steps, onedit }: { steps: OutlineRow[]; onedit: () => void } = $props();

  const filled = $derived(steps.filter((row) => row.text.trim()));
  const markers = $derived(markersFor(filled));
</script>

<div
  class="flex flex-col gap-2 rounded-box border border-base-content/10 bg-base-200 p-4"
  data-design-panel
>
  <div class="flex items-center justify-between gap-3">
    <div class="flex flex-col">
      <h3 class="font-display text-sm font-bold">Your design</h3>
      <span class="text-xs text-base-content/60">From the Design phase. Write the code one step at a time.</span>
    </div>
    <Button
      class="btn-ghost btn-xs"
      type="button"
      onclick={onedit}>Edit in Design</Button
    >
  </div>
  {#if filled.length}
    <ol class="flex flex-col gap-1 text-sm leading-relaxed">
      {#each filled as row, i (i)}
        <li
          class="flex gap-2"
          style="padding-left: {row.level * 1.25}rem"
          data-design-step
        >
          <span class="w-6 shrink-0 text-right font-mono text-xs leading-relaxed text-base-content/50"
            >{markers[i]}</span
          >
          <span>{row.text}</span>
        </li>
      {/each}
    </ol>
  {:else}
    <p class="text-sm text-base-content/60">You haven't written a design yet.</p>
  {/if}
</div>
