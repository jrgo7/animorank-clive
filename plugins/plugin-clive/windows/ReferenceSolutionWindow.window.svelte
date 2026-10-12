<script lang="ts">
  import { untrack } from 'svelte';
  import CodeEditor from '$lib/components/editor/CodeEditor.svelte';
  import type { ProblemEditorWindowContext } from '../../../src/routes/edit/[slug]/context.svelte';

  let { context }: { context: ProblemEditorWindowContext } = $props();

  /** The `extension_data.clive` shape CLive reads a problem's settings from. */
  interface CLiveExtension {
    clive?: { reference_solution?: string };
  }

  const stored = untrack(
    () => (context.problem.extension_data as CLiveExtension | null)?.clive?.reference_solution ?? ''
  );
  let code = $state(stored);

  // Write back with a whole-object reassignment, as the editor's function-data
  // effect does, so the problem's autosave notices. Depends only on `code`; the
  // stored value is read untracked so the write cannot re-run this effect.
  $effect(() => {
    const next = code;
    const prev = untrack(() => (context.problem.extension_data as CLiveExtension | null) ?? {});
    if ((prev.clive?.reference_solution ?? '') === next) return;
    context.problem.extension_data = {
      ...(prev as Record<string, unknown>),
      clive: { ...(prev.clive ?? {}), reference_solution: next }
    };
  });
</script>

<section class="flex h-full flex-col gap-2">
  <p class="shrink-0 text-xs text-base-content/60">
    A correct program for this problem, used only to check each hand-written case's expected output in the Cases phase.
    It is never shown to a student and never sent to a model.
  </p>
  <div class="min-h-0 flex-1">
    <CodeEditor
      class="h-full"
      bind:code
      language={context.problem.model.language.toLowerCase()}
    />
  </div>
</section>
