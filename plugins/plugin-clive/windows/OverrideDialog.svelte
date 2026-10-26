<script lang="ts">
  import Button from '$lib/components/ui/buttons/Button.svelte';

  /**
   * The researcher's dialog (Ctrl+Shift+Y). Nothing on the page points at it.
   *
   * Participant: tags the session with who is working in it, or starts a fresh
   * session for the next participant at a shared machine (the earlier one is left
   * as it was). Both are logged.
   *
   * Move on, ported from the prototype: moves a participant stuck behind a gate on
   * to the next phase, with an optional reason. The phase it leaves reads "Moved
   * on", never "Passed", and the override is recorded. Absent when there is no
   * next phase, or the current one has passed.
   */
  let {
    from,
    to,
    participant,
    onconfirm,
    onparticipant,
    oncancel
  }: {
    from: string;
    to: string | null;
    participant: string;
    onconfirm: (reason: string) => void;
    onparticipant: (tag: string, next: boolean) => Promise<void>;
    oncancel: () => void;
  } = $props();

  let reason = $state('');
  // The dialog opens on the current tag; editing it does not write back.
  // svelte-ignore state_referenced_locally
  let tag = $state(participant);
  let saving = $state(false);
  let failed = $state('');

  /**
   * Rendered under <body>, not inside the strip's dockview panel: the panel takes
   * focus on every click inside it, so a text box in the panel could not be typed in.
   */
  function toBody(node: HTMLElement): () => void {
    document.body.appendChild(node);
    return () => node.remove();
  }

  async function saveTag(next: boolean): Promise<void> {
    if (!tag.trim() || saving) return;
    saving = true;
    failed = '';
    try {
      await onparticipant(tag.trim(), next);
    } catch (error) {
      failed = error instanceof Error ? error.message : String(error);
    } finally {
      saving = false;
    }
  }
</script>

<div
  class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
  role="presentation"
  {@attach toBody}
>
  <div
    class="flex w-[min(28rem,92vw)] flex-col gap-4 rounded-box border border-base-content/10 bg-base-100 p-5"
    role="dialog"
    aria-label="Researcher override"
  >
    <h3 class="font-display text-base font-bold">Researcher</h3>

    <section
      class="flex flex-col gap-2"
      data-participant
    >
      <label class="flex flex-col gap-1 text-sm">
        Participant {participant ? `(now ${participant})` : '(untagged)'}
        <input
          class="input input-bordered input-sm"
          bind:value={tag}
          placeholder="e.g. P07"
          onkeydown={(e) => {
            if (e.key === 'Enter') void saveTag(false);
          }}
        />
      </label>
      <div class="flex flex-wrap justify-end gap-2">
        <Button
          class="btn-ghost btn-sm"
          type="button"
          disabled={!tag.trim() || saving}
          onclick={() => saveTag(false)}>Tag this session</Button
        >
        <Button
          class="btn-sm"
          type="button"
          disabled={!tag.trim() || saving}
          onclick={() => saveTag(true)}>New participant: fresh session</Button
        >
      </div>
      {#if failed}
        <p class="text-xs text-error">{failed}</p>
      {/if}
    </section>

    {#if to}
      <section class="flex flex-col gap-2 border-t border-base-content/10 pt-4">
        <p class="text-sm text-base-content/70">
          Move on from {from} to {to}? {from} will show as "Moved on", not "Passed", and this is logged.
        </p>
        <label class="flex flex-col gap-1 text-sm">
          Reason (optional)
          <!-- svelte-ignore a11y_autofocus -->
          <input
            class="input input-bordered input-sm"
            bind:value={reason}
            placeholder="e.g. stuck 15 min on the same requirement"
            autofocus
            onkeydown={(e) => {
              if (e.key === 'Enter') onconfirm(reason.trim());
            }}
          />
        </label>
        <div class="flex justify-end">
          <Button
            class="btn-primary btn-sm"
            type="button"
            onclick={() => onconfirm(reason.trim())}>Move on to {to}</Button
          >
        </div>
      </section>
    {/if}

    <div class="flex justify-end">
      <Button
        class="btn-ghost btn-sm"
        type="button"
        onclick={oncancel}>Close</Button
      >
    </div>
  </div>
</div>
