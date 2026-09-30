<script lang="ts">
  import Textarea from '$lib/components/ui/textareas/Textarea.svelte';
  import Button from '$lib/components/ui/buttons/Button.svelte';
  import TrashIcon from '@iconify-svelte/fa6-solid/trash';
  import PlusIcon from '@iconify-svelte/fa6-solid/plus';
  import { SvelteSet } from 'svelte/reactivity';
  import { blankRow, type ArtifactValue } from './cliveSession.svelte';
  import type { CaseRow } from './phase';

  interface Props {
    label: string;
    /** Rows the judge asked the student to re-check, named e.g. "Case 2 in Typical cases" (see `Verdict.recheck`). */
    recheck?: Set<string>;
    disabled?: boolean;
    rows: ArtifactValue;
    onchange: () => void;
  }

  let { label, recheck = new SvelteSet(), disabled = false, rows, onchange }: Props = $props();

  // `rows` is typed as the field's general `ArtifactValue` so a caller can pass
  // `artifact[f.id]` directly; a `cases` field's value is always an array once
  // `PhaseState` has initialized it, so this narrows for the template below.
  // No `$bindable` needed: every mutation below is in place (`splice`/`push`
  // on the same array, or a property write on one of its rows), which the
  // parent's own `$state` already tracks through the shared reference.
  let list = $derived(rows as CaseRow[]);

  function remove(i: number): void {
    list.splice(i, 1);
    onchange();
  }

  function add(): void {
    list.push(blankRow());
    onchange();
  }
</script>

<div class="flex flex-col gap-2.5">
  {#each list as row, i (i)}
    {@const n = i + 1}
    {@const flagged = recheck.has(`Case ${n} in ${label}`)}
    <div
      class="rounded-lg border p-3 pb-3.5 {flagged
        ? 'border-error shadow-[inset_3px_0_0_var(--color-error)]'
        : 'border-base-content/15'} bg-base-200"
    >
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
      <div class="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        <label class="flex flex-col gap-1 text-xs text-base-content/70">
          <span>Input</span>
          <Textarea
            rows={2}
            class="font-mono text-sm"
            aria-label={`Input, case ${n} in ${label}`}
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
            aria-label={`Expected output, case ${n} in ${label}`}
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
          aria-label={`How I got it, case ${n} in ${label}`}
          bind:value={row.working}
          {disabled}
          oninput={onchange}
        />
      </label>
    </div>
  {/each}
  <Button
    class="btn-ghost btn-sm w-fit justify-start gap-2 border border-dashed border-base-content/20 text-base-content/70"
    type="button"
    {disabled}
    onclick={add}
  >
    <PlusIcon class="h-3 w-3" />
    Add a case
  </Button>
</div>
