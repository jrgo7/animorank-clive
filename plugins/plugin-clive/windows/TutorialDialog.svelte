<script lang="ts">
  import Button from '$lib/components/ui/buttons/Button.svelte';

  interface Card {
    title: string;
    body: string;
  }

  interface Props {
    onclose: () => void;
  }

  let { onclose }: Props = $props();

  /**
   * Short cards on a first visit, skippable from any of them and reopened from
   * "How this works". Ported from the prototype's tutorial (wording is a draft
   * for the author to revise).
   */
  const CARDS: readonly Card[] = [
    {
      title: 'Four phases',
      body: "Good programmers don't start by typing code. You'll work through four phases, shown along the top. Each one opens once the one before it passes, and you can always go back to a passed phase."
    },
    {
      title: 'Problem',
      body: 'First, understand the problem. Before you think about code, say in your own words what the program is given and what it must display.'
    },
    {
      title: 'Cases',
      body: 'Then solve it yourself. Pick some values and work out by hand what the program should display, and how you got there.'
    },
    {
      title: 'Design',
      body: 'Then turn what you did by hand into steps, in plain English. The C comes after.'
    },
    {
      title: 'Implement',
      body: 'Last, you write the C program, with the problem and your design beside it. Run tries it on the examples as often as you like; Submit does the final check.'
    },
    {
      title: 'One question at a time',
      body: 'Answer the question on screen, then go on to the next. "Show an example for a different problem" shows how someone answered a different problem. It doesn\'t fill in your answer.'
    },
    {
      title: 'Feedback',
      body: 'When you submit, CLive checks your work and points at one thing to fix. Fix it and submit again. Optional points are worth a look, but they never stop you from moving on.'
    }
  ];

  let index = $state(0);
  const last = $derived(index === CARDS.length - 1);

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      onclose();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div
  class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
  role="dialog"
  aria-modal="true"
  aria-label="How this works"
>
  <div class="flex w-full max-w-[440px] flex-col gap-3 rounded-box bg-base-100 p-5 shadow-xl">
    <div class="font-mono text-xs text-base-content/50">{index + 1} of {CARDS.length}</div>
    <h3 class="font-display text-lg font-bold">{CARDS[index].title}</h3>
    <p class="text-sm leading-relaxed text-base-content/80">{CARDS[index].body}</p>
    <div class="mt-1 flex flex-wrap items-center justify-between gap-3">
      <Button
        class="btn-ghost btn-sm"
        type="button"
        onclick={onclose}>Skip</Button
      >
      <div class="flex gap-2">
        {#if index > 0}
          <Button
            class="btn-ghost btn-sm"
            type="button"
            onclick={() => {
              index -= 1;
            }}>Previous</Button
          >
        {/if}
        <Button
          class="btn-primary btn-sm"
          type="button"
          onclick={() => {
            if (last) onclose();
            else index += 1;
          }}
        >
          {last ? 'Start' : 'Next'}
        </Button>
      </div>
    </div>
  </div>
</div>
