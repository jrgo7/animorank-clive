<script lang="ts">
  import { tick } from 'svelte';
  import { markersFor, normaliseOutline, parseOutline, STEP_LEVELS, type OutlineRow } from './phase';

  interface Props {
    rows: OutlineRow[];
    disabled?: boolean;
    onchange: () => void;
  }

  let { rows, disabled = false, onchange }: Props = $props();

  let areas: (HTMLTextAreaElement | undefined)[] = [];

  const marks = $derived(markersFor(rows));

  // Keep every row's height hugging its text after a structural change or mount.
  $effect(() => {
    void rows.length;
    void tick().then(() => {
      for (const el of areas) if (el) grow(el);
    });
  });

  function grow(el: HTMLTextAreaElement): void {
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }

  /** Move focus (and the caret) once the DOM has caught up with a structural change. */
  async function focusStep(index: number, caret = 0): Promise<void> {
    await tick();
    const el = areas[index];
    if (!el) return;
    el.focus();
    el.setSelectionRange(caret, caret);
    grow(el);
  }

  function changed(): void {
    normaliseOutline(rows);
    onchange();
  }

  function indent(i: number): void {
    if (i > 0 && rows[i].level < Math.min(rows[i - 1].level + 1, STEP_LEVELS - 1)) rows[i].level += 1;
    changed();
    void focusStep(i, areas[i]?.selectionStart ?? 0);
  }

  function outdent(i: number): void {
    if (rows[i].level > 0) rows[i].level -= 1;
    changed();
    void focusStep(i, areas[i]?.selectionStart ?? 0);
  }

  function keydown(event: KeyboardEvent, i: number): void {
    const el = event.currentTarget as HTMLTextAreaElement;
    const at = el.selectionStart;
    const end = el.selectionEnd;
    if (event.key === 'Enter') {
      event.preventDefault();
      const rest = rows[i].text.slice(end);
      rows[i].text = rows[i].text.slice(0, at);
      rows.splice(i + 1, 0, { text: rest, level: rows[i].level });
      changed();
      void focusStep(i + 1, 0);
    } else if (event.key === 'Tab') {
      event.preventDefault();
      (event.shiftKey ? outdent : indent)(i);
    } else if (event.key === 'Backspace' && !rows[i].text && rows.length > 1) {
      event.preventDefault();
      rows.splice(i, 1);
      changed();
      void focusStep(Math.max(0, i - 1));
    } else if (event.key === 'Backspace' && at === 0 && end === 0 && rows[i].level > 0) {
      // At the start of a nested step, Backspace un-nests it first, as a document does.
      event.preventDefault();
      outdent(i);
    } else if (event.key === 'Backspace' && at === 0 && end === 0 && i > 0) {
      // ...and at the start of a top-level step it joins it onto the step before, so an
      // Enter pressed mid-sentence can be undone.
      event.preventDefault();
      const join = rows[i - 1].text.length;
      rows[i - 1].text += rows[i].text;
      rows.splice(i, 1);
      changed();
      void focusStep(i - 1, join);
    } else if (event.key === 'ArrowUp' && at === 0 && end === 0 && i > 0) {
      event.preventDefault();
      void focusStep(i - 1);
    } else if (event.key === 'ArrowDown' && at === el.value.length && i < rows.length - 1) {
      event.preventDefault();
      void focusStep(i + 1, 0);
    }
  }

  /** Several lines pasted at once become steps: indentation sets the nesting, markers go. */
  function paste(event: ClipboardEvent, i: number): void {
    const text = event.clipboardData?.getData('text') ?? '';
    if (!/\n/.test(text)) return;
    const parsed = parseOutline(text);
    if (!parsed.length) return;
    event.preventDefault();
    const el = event.currentTarget as HTMLTextAreaElement;
    const before = rows[i].text.slice(0, el.selectionStart);
    const after = rows[i].text.slice(el.selectionEnd);
    const base = rows[i].level;
    const [first, ...rest] = parsed;
    rows[i].text = before + first.text;
    const added = rest.map((row) => ({ text: row.text, level: base + row.level }));
    if (added.length) added[added.length - 1].text += after;
    else rows[i].text += after;
    rows.splice(i + 1, 0, ...added);
    changed();
    void focusStep(i + added.length, 0);
  }
</script>

<div class="flex flex-col gap-1.5">
  <div class="rounded-lg border border-base-content/15 bg-base-200 px-1.5 py-2 focus-within:border-primary">
    {#each rows as row, i (i)}
      <div
        class="flex items-start gap-1"
        style="padding-left: {row.level * 1.6}em"
      >
        <span class="mt-2 w-4 shrink-0 text-right font-mono text-xs text-base-content/50">{marks[i]}</span>
        <textarea
          bind:this={areas[i]}
          rows="1"
          class="field-sizing-content min-h-0 w-full resize-none border-0 bg-transparent py-1 text-sm leading-snug outline-none"
          aria-label={`Step ${marks[i]}`}
          readonly={disabled}
          value={row.text}
          oninput={(e) => {
            row.text = (e.currentTarget as HTMLTextAreaElement).value.replace(/\n/g, ' ');
            grow(e.currentTarget as HTMLTextAreaElement);
            onchange();
          }}
          onkeydown={(e) => keydown(e, i)}
          onpaste={(e) => paste(e, i)}
        ></textarea>
        <span class="flex shrink-0 items-center">
          <button
            type="button"
            class="btn btn-ghost btn-xs px-1 text-base-content/60"
            title="Outdent (Shift+Tab)"
            aria-label="Outdent step"
            {disabled}
            onmousedown={(e) => e.preventDefault()}
            onclick={() => outdent(i)}>⇤</button
          >
          <button
            type="button"
            class="btn btn-ghost btn-xs px-1 text-base-content/60"
            title="Indent (Tab)"
            aria-label="Indent step"
            {disabled}
            onmousedown={(e) => e.preventDefault()}
            onclick={() => indent(i)}>⇥</button
          >
        </span>
      </div>
    {/each}
  </div>
  <div class="text-xs text-base-content/60">Enter: new step · Tab: indent · Shift+Tab: outdent</div>
</div>
