<script lang="ts">
  import Textarea from '$lib/components/ui/textareas/Textarea.svelte';
  import Button from '$lib/components/ui/buttons/Button.svelte';
  import TrashIcon from '@iconify-svelte/fa6-solid/trash';
  import PlusIcon from '@iconify-svelte/fa6-solid/plus';
  import { SvelteSet } from 'svelte/reactivity';
  import { blankRow, rowsOf, type ArtifactValue } from './phase';

  interface Props {
    label: string;
    /** Rows the judge asked the student to re-check, named by the server (see `Verdict.recheck`). */
    recheck?: Set<string>;
    disabled?: boolean;
    /** A stepped Cases phase holds exactly one case per field: no header, no add or remove. */
    single?: boolean;
    rows: ArtifactValue;
    onchange: () => void;
  }

  let { label, recheck = new SvelteSet(), disabled = false, single = false, rows, onchange }: Props = $props();

  // `rows` is typed as the field's general `ArtifactValue` so a caller can pass
  // `artifact[f.id]` directly; a `cases` field's value is always an array once
  // `PhaseState` has initialized it. No `$bindable` needed: every mutation below is
  // in place, which the parent's own `$state` already tracks.
  let list = $derived(rowsOf(rows));

  /**
   * Whether the server named this row in `recheck`. A field that holds one case
   * (a stepped phase) is named by its own label; a multi-row field by
   * `Case <n> in <label>`.
   */
  function isFlagged(index: number): boolean {
    return recheck.has(single ? label : `Case ${index + 1} in ${label}`);
  }

  function remove(i: number): void {
    list.splice(i, 1);
    onchange();
  }

  function add(): void {
    list.push(blankRow());
    onchange();
  }

  const shown = $derived(single ? list.slice(0, 1) : list);
</script>

<div class="flex flex-col gap-2.5">
  {#each shown as row, i (i)}
    {@const n = i + 1}
    <div
      class="rounded-lg border p-3 pb-3.5 {isFlagged(i)
        ? 'border-error shadow-[inset_3px_0_0_var(--color-error)]'
        : 'border-base-content/15'} bg-base-200"
    >
      {#if !single}
        <div class="mb-1.5 flex items-center justify-between font-mono text-xs text-base-content/50">
          <span>Case {n}</span>
          {#if list.length > 1}
            <Button
              class="btn-ghost btn-xs px-1.5 text-base-content/50 hover:text-base-content"
              type="button"
              aria-label={`Remove case ${n}`}
              {disabled}
              onclick={() => remove(i)}
            >
              <TrashIcon class="h-3 w-3" />
            </Button>
          {/if}
        </div>
      {/if}
      <div class="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        <label class="flex flex-col gap-1 text-xs text-base-content/70">
          <span>Input</span>
          <Textarea
            rows={2}
            class="font-mono text-sm"
            aria-label={`Input, ${single ? label : `case ${n} in ${label}`}`}
            bind:value={row.input}
            {disabled}
            oninput={onchange}
          />
        </label>
        <label class="flex flex-col gap-1 text-xs text-base-content/70">
          <span>Expected output</span>
          <Textarea
            rows={2}
            class="font-mono text-sm"
            aria-label={`Expected output, ${single ? label : `case ${n} in ${label}`}`}
            bind:value={row.output}
            {disabled}
            oninput={onchange}
          />
        </label>
      </div>
      <label class="mt-2 flex flex-col gap-1 text-xs text-base-content/70">
        <span>How I got it</span>
        <Textarea
          rows={3}
          aria-label={`How I got it, ${single ? label : `case ${n} in ${label}`}`}
          bind:value={row.working}
          {disabled}
          oninput={onchange}
        />
      </label>
    </div>
  {/each}
  {#if !single}
    <Button
      class="btn-ghost btn-sm w-fit justify-start gap-2 border border-dashed border-base-content/20 text-base-content/70"
      type="button"
      {disabled}
      onclick={add}
    >
      <PlusIcon class="h-3 w-3" />
      Add a case
    </Button>
  {/if}
</div>
