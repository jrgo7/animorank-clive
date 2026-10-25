/**
 * The live reasoning window (Ctrl+Shift+L): one block per model call, its
 * reasoning appearing as it streams. It polls `live/events` every half second
 * (plugin routes are buffered, so nothing can stream to it).
 */
export function livePage(session: string): string {
  const id = JSON.stringify(session);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>CLive live reasoning</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light dark; --bg: #fff; --fg: #1d1d1f; --muted: #6b6b70; --line: #e3e3e6; }
  @media (prefers-color-scheme: dark) { :root { --bg: #141416; --fg: #ececf0; --muted: #9a9aa2; --line: #2a2a30; } }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 13px/1.5 ui-sans-serif, system-ui, sans-serif; }
  header { position: sticky; top: 0; background: var(--bg); border-bottom: 1px solid var(--line); padding: 10px 16px; }
  main { padding: 8px 16px 40px; }
  .call { border: 1px solid var(--line); border-radius: 8px; margin: 10px 0; padding: 10px 12px; }
  .head { font-weight: 600; } .meta { color: var(--muted); font-size: 12px; }
  pre { white-space: pre-wrap; word-break: break-word; margin: 6px 0 0; font: 12px/1.5 ui-monospace, monospace; }
  .err { color: #d33; }
</style></head>
<body><header><b>CLive</b> live reasoning <span class="meta" id="state">waiting…</span></header><main id="calls"></main>
<script>
const session = ${id};
let after = 0; const blocks = {};
function block(call, purpose) {
  if (!blocks[call]) {
    const el = document.createElement('section'); el.className = 'call';
    el.innerHTML = '<div class="head"></div><div class="meta">thinking…</div><pre></pre>';
    el.querySelector('.head').textContent = purpose || 'call';
    document.getElementById('calls').prepend(el); blocks[call] = el;
  }
  return blocks[call];
}
async function poll() {
  try {
    const res = await fetch('live/events?session=' + encodeURIComponent(session) + '&after=' + after);
    if (res.ok) {
      const { events, last } = await res.json(); after = last;
      for (const e of events) {
        const el = block(e.call, e.purpose);
        if (e.kind === 'reasoning') el.querySelector('pre').textContent += e.text;
        if (e.kind === 'end') {
          const meta = el.querySelector('.meta');
          meta.textContent = e.info.error ? 'failed: ' + e.info.error : (e.info.latency_ms / 1000).toFixed(1) + ' s, ' + (e.info.output_tokens ?? '?') + ' tokens out';
          if (e.info.error) meta.classList.add('err');
        }
      }
      document.getElementById('state').textContent = 'watching';
    } else { document.getElementById('state').textContent = 'not allowed (' + res.status + ')'; }
  } catch { document.getElementById('state').textContent = 'reconnecting…'; }
  setTimeout(poll, 500);
}
poll();
</script></body></html>`;
}
