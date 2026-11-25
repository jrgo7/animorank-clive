<script lang="ts">
  import Button from '$lib/components/ui/buttons/Button.svelte';
  import LightbulbIcon from '@iconify-svelte/fa6-solid/lightbulb';

  /**
   * "I'm stuck": the hint ladder's one button, the same in every phase. It sits at
   * the foot of the card whose hint it goes further from: the "Start here" card in
   * Problem, Cases and Design (`FieldFeedback.svelte`), the latest reply about the
   * code in Implement.
   */
  let {
    disabled = false,
    onclick
  }: {
    /** The page is busy, or no model is configured. */
    disabled?: boolean;
    onclick?: () => void;
  } = $props();
</script>

<div class="flex flex-wrap items-center gap-2.5 border-t border-base-content/10 pt-2.5">
  <Button
    class="btn-sm gap-2"
    type="button"
    {disabled}
    onclick={() => onclick?.()}
  >
    <LightbulbIcon class="h-3.5 w-3.5" />
    I'm stuck
  </Button>
</div>
