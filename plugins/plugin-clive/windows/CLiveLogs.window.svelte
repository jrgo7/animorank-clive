<script lang="ts">
  import Badge from '$lib/components/ui/badges/Badge.svelte';
  import { formatLogTime } from '$lib/analytics/sessionLogTime';
  import type { SessionLogEntry } from '$lib/analytics/sessionLogView';
  import type { SessionLogsViewContext } from '../../../src/routes/instructor/analytics/session-logs/context.svelte';
  import { attachCalls, asRecord, offsetLabel, prettyValue, type CliveLogEvent } from './cliveLogs';

  let { context }: { context: SessionLogsViewContext } = $props();

  /** Entries this view knows how to tell apart; everything else belongs to Raw logs. */
  const CLIVE_PREFIX = 'CLIVE_';

  const events = $derived(attachCalls(context.logs.filter((entry) => entry.type.startsWith(CLIVE_PREFIX))));

  /** The first moment these logs recorded, for each row's `+m:ss`. */
  const start = $derived(events[0]?.entry.timestamp ?? null);

  const counts = $derived.by(() => {
    let submits = 0;
    let stuck = 0;
    let runs = 0;
    let errors = 0;
    let calls = 0;
    let failedCalls = 0;
    for (const event of events) {
      if (event.entry.type === 'CLIVE_SUBMIT') submits += 1;
      if (event.entry.type === 'CLIVE_STUCK') stuck += 1;
      if (event.entry.type === 'CLIVE_RUN') runs += 1;
      if (event.entry.type === 'CLIVE_ERROR') errors += 1;
      for (const call of event.calls) {
        calls += 1;
        if (asRecord(call.data).error) failedCalls += 1;
      }
    }
    return { submits, stuck, runs, errors, calls, failedCalls };
  });

  /**
   * Events the page recorded that have no card of their own: a navigation line,
   * as the prototype's Logs page showed them.
   */
  const NAV_TITLES: Record<string, string> = {
    CLIVE_SESSION_START: 'Session started',
    CLIVE_PROBLEM_LOAD: 'Problem loaded',
    CLIVE_PHASE_OPEN: 'Phase opened',
    CLIVE_PROBLEM_READ: 'Problem read',
    CLIVE_CASE_ADDED: 'Case added',
    CLIVE_CASE_REMOVED: 'Case removed',
    CLIVE_LIVE_CHECK_READY: 'Live checking ready',
    CLIVE_LIVE_CHECK_FAILED: 'Live checking failed',
    CLIVE_LIVE_CHECK: 'Live check',
    CLIVE_LIVE_RAW_TOGGLE: "Compiler's own words",
    CLIVE_LOG_CHECK: 'Log check',
    CLIVE_ORPHAN_CALLS: 'Model calls with no event after them'
  };

  function rows(value: unknown): Record<string, unknown>[] {
    return Array.isArray(value) ? value.map(asRecord) : [];
  }

  function secs(ms: unknown): string {
    const value = Number(ms);
    return Number.isFinite(value) ? `${(value / 1000).toFixed(1)}s` : '?';
  }

  function dotClass(type: string, data: Record<string, unknown>): string {
    if (type === 'CLIVE_SUBMIT') return asRecord(data.response).passed ? 'bg-success' : 'bg-error';
    if (type === 'CLIVE_RUN') return data.passed ? 'bg-success' : 'bg-error';
    if (type === 'CLIVE_ERROR') return 'bg-error';
    if (type === 'CLIVE_STUCK') return 'bg-warning';
    return 'bg-base-content/30';
  }

  /** What a navigation event says about itself, in the prototype's one-line form. */
  function navDetail(type: string, data: Record<string, unknown>): string {
    if (type === 'CLIVE_LIVE_CHECK') {
      const diagnostics = rows(data.diagnostics);
      if (diagnostics.length === 0) return 'Live: none';
      const kinds = [...new Set(diagnostics.map((mark) => String(mark.kind)))].join(', ');
      return `Live: ${diagnostics.length} marked (${kinds}) · lines ${diagnostics
        .map((mark) => String(mark.line))
        .join(', ')}`;
    }
    return Object.entries(data)
      .map(
        ([key, value]) =>
          `${key}: ${typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value)}`
      )
      .join(' · ');
  }
</script>

<section class="flex flex-col gap-3">
  <div class="flex flex-wrap items-baseline justify-between gap-2">
    <h2 class="font-display text-lg font-semibold">CLive events</h2>
    <span class="text-xs text-base-content/60">
      {events.length} entries · {counts.calls} model calls · {counts.submits} submit{counts.submits === 1 ? '' : 's'} · {counts.stuck}
      stuck ask{counts.stuck === 1 ? '' : 's'} · {counts.runs} run{counts.runs === 1 ? '' : 's'}{#if counts.errors > 0}
        · {counts.errors} error{counts.errors === 1 ? '' : 's'}{/if}{#if counts.failedCalls > 0}
        · {counts.failedCalls} failed call{counts.failedCalls === 1 ? '' : 's'}{/if}
    </span>
  </div>

  {#if context.logs.length === 0}
    <p class="rounded-box bg-base-200 p-8 text-center text-base-content/60">No logs for this session.</p>
  {:else if events.length === 0}
    <p class="rounded-box bg-base-200 p-8 text-center text-base-content/60">
      No CLive events in this session. Other entries are in Raw logs.
    </p>
  {:else}
    <div class="ml-2 border-l-2 border-base-content/10 pl-5">
      {#each events as event (event.entry.id)}
        {@const data = asRecord(event.entry.data)}
        {@const nav = NAV_TITLES[event.entry.type]}
        <div class="relative py-2.5">
          <span
            class="absolute -left-[29px] top-[17px] size-2 rounded-full ring-2 ring-base-100 {dotClass(
              event.entry.type,
              data
            )}"
          ></span>

          <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <time
              class="min-w-32 font-mono text-[11px] text-base-content/50"
              datetime={event.entry.timestamp}
              >{offsetLabel(event.entry.timestamp, start)} {formatLogTime(event.entry.timestamp)}</time
            >
            {#if nav}
              <span class="font-semibold">{nav}</span>
              {#if event.entry.type === 'CLIVE_ORPHAN_CALLS'}
                <span class="text-xs text-warning">
                  The server stopped, or the request was cut off, before the event they served was written.
                </span>
              {:else}
                <span class="text-sm text-base-content/60">{navDetail(event.entry.type, data)}</span>
              {/if}
            {:else if event.entry.type === 'CLIVE_RUN'}
              {@const passed = data.passed === true}
              <span class="font-semibold">Run · {data.problem ?? 'unknown problem'}</span>
              <Badge class={passed ? 'badge-success badge-sm' : 'badge-error badge-sm'}
                >{passed ? 'passed' : 'tests failed'}</Badge
              >
            {:else if event.entry.type === 'CLIVE_SUBMIT'}
              {@const passed = asRecord(data.response).passed === true}
              <span class="font-semibold">
                Submit · {data.phase_id ?? 'unknown phase'} · {data.problem_id ?? 'unknown problem'} · attempt {data.attempt ??
                  '?'}
              </span>
              <Badge class={passed ? 'badge-success badge-sm' : 'badge-error badge-sm'}
                >{passed ? 'passed' : 'blocked'}</Badge
              >
            {:else if event.entry.type === 'CLIVE_STUCK'}
              <span class="font-semibold">
                Stuck · {data.phase_id ?? 'unknown phase'} · {data.problem_id ?? 'unknown problem'}{data.field_id
                  ? ` · ${data.field_id}`
                  : ''} · attempt {data.attempt ?? '?'}
              </span>
            {:else if event.entry.type === 'CLIVE_ERROR'}
              <span class="font-semibold">Error during {data.call ?? 'a request'}</span>
              <Badge class="badge-error badge-sm">failed</Badge>
            {:else}
              <span class="font-semibold">{event.entry.type}</span>
            {/if}
          </div>

          {#if !nav}
            <div class="mt-1.5 rounded-box border border-base-content/10 bg-base-200 p-3">
              {#if event.entry.type === 'CLIVE_RUN'}
                <p class="text-sm">
                  Tests: {data.tests_passed ?? 0}/{data.tests_total ?? 0} passed{#if data.phase}{` · ${data.phase}`}{/if}
                </p>
              {:else if event.entry.type === 'CLIVE_SUBMIT'}
                {@const response = asRecord(data.response)}
                {@const verdicts = rows(response.verdicts)}
                {@const missing = Array.isArray(response.missing_ids) ? response.missing_ids.map(String) : []}
                {@const nudge = asRecord(response.nudge)}
                {#each Object.entries(asRecord(data.artifact)) as [name, value] (name)}
                  {@render preField(name, value)}
                {/each}

                {#if verdicts.length > 0}
                  <div class="mt-2">
                    <h4 class="text-[11px] font-semibold uppercase tracking-wide text-base-content/50">Verdicts</h4>
                    {#each verdicts as verdict, index (`${verdict.criterion_id ?? 'criterion'}-${index}`)}
                      <div
                        class="mt-2 grid grid-cols-[4.5rem_1fr] gap-2 pt-2 {index > 0
                          ? 'border-t border-base-content/10'
                          : ''}"
                      >
                        <Badge class={verdict.verdict === 'PASS' ? 'badge-success badge-sm' : 'badge-error badge-sm'}
                          >{verdict.verdict ?? '?'}</Badge
                        >
                        <div>
                          <div class="text-sm">
                            {verdict.criterion_text || verdict.criterion_id || 'unnamed criterion'}
                            <span class="text-xs text-base-content/50">({verdict.gate ?? '?'})</span>
                          </div>
                          {#if verdict.evidence}
                            <div class="text-xs text-base-content/60">“{verdict.evidence}”</div>
                          {/if}
                          {#if verdict.evidence_found === false}
                            <div class="text-xs text-warning">The judge's quote is not in the artifact.</div>
                          {/if}
                        </div>
                      </div>
                    {/each}
                  </div>
                {/if}

                {#if missing.length > 0}
                  <p class="mt-2 rounded-box bg-warning/10 p-2 text-xs text-warning">
                    The judge did not rule on: {missing.join(', ')}
                  </p>
                {/if}

                {#if Object.keys(nudge).length > 0}
                  <div class="mt-2">
                    <h4 class="text-[11px] font-semibold uppercase tracking-wide text-base-content/50">Nudge</h4>
                    {#if nudge.summary}
                      <p class="text-sm">{nudge.summary}</p>
                    {/if}
                    {#if nudge.focus_not_met}
                      <p class="text-xs text-base-content/60">Focus: {nudge.focus_not_met}</p>
                    {/if}
                    {#if nudge.nudge}
                      <pre
                        class="mt-1 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-box bg-base-300 p-2 font-mono text-xs">{prettyValue(
                          nudge.nudge
                        )}</pre>
                    {/if}
                  </div>
                {/if}

                {#if typeof response.nudge_error === 'string' && response.nudge_error}
                  <p class="mt-2 rounded-box bg-error/10 p-2 text-xs text-error">
                    The nudge failed: {response.nudge_error}
                  </p>
                {/if}
              {:else if event.entry.type === 'CLIVE_STUCK'}
                {@render preField('Student said', data.statement)}
                {@render preField('Diagnosis (not shown to the student)', data.diagnosis)}
                {@render preField('Feedback', asRecord(data.response).feedback)}
                {#if Array.isArray(data.history) && data.history.length > 0}
                  <p class="mt-2 text-xs text-base-content/50">
                    Asked with {data.history.length} earlier ask{data.history.length === 1 ? '' : 's'} in the history.
                  </p>
                {/if}
              {:else if event.entry.type === 'CLIVE_ERROR'}
                <p class="rounded-box bg-error/10 p-2 text-sm text-error">{data.error ?? 'Unknown error'}</p>
                {#each Object.entries(asRecord(data.artifact)) as [name, value] (name)}
                  {@render preField(name, value)}
                {/each}
              {/if}

              {#if event.calls.length > 0}
                {@render callsBlock(event.calls)}
              {/if}

              {@render rawEntry(event)}
            </div>
          {:else if event.calls.length > 0}
            <div class="mt-1.5 rounded-box border border-base-content/10 bg-base-200 p-3">
              {@render callsBlock(event.calls)}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</section>

{#snippet preField(label: string, value: unknown)}
  {#if value !== null && value !== undefined && value !== ''}
    <div class="mt-2">
      <h4 class="text-[11px] font-semibold uppercase tracking-wide text-base-content/50">{label}</h4>
      <pre
        class="mt-1 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-box bg-base-300 p-2 font-mono text-xs">{prettyValue(
          value
        )}</pre>
    </div>
  {/if}
{/snippet}

{#snippet callsBlock(calls: SessionLogEntry[])}
  {@const failed = calls.filter((call) => asRecord(call.data).error).length}
  <details
    class="mt-2 rounded-box border border-base-content/10 p-3"
    open={failed > 0}
  >
    <summary class="cursor-pointer text-sm font-semibold">
      Model calls ({calls.length}) ·
      {secs(calls.reduce((total, call) => total + (Number(asRecord(call.data).latency_ms) || 0), 0))}
      {#if failed > 0}
        <Badge class="badge-error badge-sm">{failed} failed</Badge>
      {/if}
    </summary>

    {#each calls as call (call.id)}
      {@const c = asRecord(call.data)}
      {@const checks = asRecord(c.checks)}
      {@const flagged = Object.entries(checks).filter(([, value]) => Array.isArray(value) && value.length > 0)}
      <details
        class="ml-3 mt-2 border-l-2 border-base-content/10 pl-3"
        open={Boolean(c.error)}
      >
        <summary class="cursor-pointer text-sm">
          <span class="font-semibold">{c.purpose ?? 'call'}</span> · {c.model ?? 'no reply'} · {c.input_tokens ?? '?'} in
          / {c.output_tokens ?? '?'} out{#if c.reasoning_tokens}
            ({c.reasoning_tokens} reasoning){/if} · {secs(c.latency_ms)}{#if c.stop_reason}
            · {c.stop_reason}{/if}
          {#if c.error}
            <Badge class="badge-error badge-sm">failed</Badge>
          {/if}
        </summary>

        {#if c.error}
          {@render preField('Error', c.error)}
        {/if}

        {#if Object.keys(checks).length > 0}
          <div class="mt-2">
            <h4 class="text-[11px] font-semibold uppercase tracking-wide text-base-content/50">Judge audit</h4>
            {#if flagged.length > 0}
              <pre
                class="mt-1 overflow-auto whitespace-pre-wrap break-words rounded-box bg-base-300 p-2 font-mono text-xs">{flagged
                  .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
                  .join('\n')}</pre>
            {:else}
              <p class="text-xs text-base-content/50">Nothing flagged.</p>
            {/if}
          </div>
        {/if}

        {@render preField('System prompt', c.system)}
        {@render preField('User prompt', c.user)}
        {@render preField('Reasoning', c.reasoning)}
        {@render preField('Raw reply', c.raw_text || '(none)')}

        <p class="mt-2 text-xs text-base-content/50">
          provider {c.provider ?? '?'} · requested {c.model_requested ?? '?'} · effort {c.effort ?? '?'} · request {c.request_id ??
            '—'}{#if typeof c.started === 'string'}
            · started {formatLogTime(c.started)}{/if}
        </p>
      </details>
    {/each}
  </details>
{/snippet}

{#snippet rawEntry(event: CliveLogEvent)}
  <details class="mt-2">
    <summary class="cursor-pointer text-xs text-base-content/50">Raw entry</summary>
    <pre
      class="mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-box bg-base-300 p-2 font-mono text-xs">{JSON.stringify(
        { type: event.entry.type, timestamp: event.entry.timestamp, data: event.entry.data },
        null,
        2
      )}</pre>
  </details>
{/snippet}
