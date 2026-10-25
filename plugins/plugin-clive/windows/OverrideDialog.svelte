<script lang="ts">
  import Button from '$lib/components/ui/buttons/Button.svelte';

  /**
   * The researcher override (Ctrl+Shift+Y), ported from the prototype: moves a
   * participant stuck behind a gate on to the next phase, with an optional reason.
   * Nothing on the page points at it. The phase it leaves reads "Moved on", never
   * "Passed", and the override is recorded.
   */
  let {
    from,
    to,
    onconfirm,
    oncancel
  }: { from: string; to: string; onconfirm: (reason: string) => void; oncancel: () => void } = $props();

  let reason = $state('');
</script>

<div
  class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
  role="presentation"
>
  <div
    class="flex w-[min(28rem,92vw)] flex-col gap-3 rounded-box border border-base-content/10 bg-base-100 p-5"
    role="dialog"
    aria-label="Researcher override"
  >
    <h3 class="font-display text-base font-bold">Researcher override</h3>
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
    <div class="flex justify-end gap-2">
      <Button
        class="btn-ghost btn-sm"
        type="button"
        onclick={oncancel}>Cancel</Button
      >
      <Button
        class="btn-primary btn-sm"
        type="button"
        onclick={() => onconfirm(reason.trim())}>Move on to {to}</Button
      >
    </div>
  </div>
</div>
