// @vitest-environment happy-dom
/**
 * The live-checking bar under the Implement phase's code box, mounted for real
 * (`npm run test:component`): the note while clangd loads, the raw-words box, and
 * the silence when live checking is off, unavailable on this machine or dead.
 *
 * The bar reads the plugin's one `live` state, so each test sets that state the
 * way the page would have reached it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import ImplementWindow from './ImplementWindow.window.svelte';
import { live } from './live.svelte';
import type { SolveWindowContext } from '../../../src/routes/problem/[problem_id]/[session_id]/context.svelte';

const NOTE = 'Checking as you type will start in a moment';
const BOX = "Show the compiler's own words";

let mounted: Record<string, unknown> | undefined;

/**
 * A session that reached the Implement phase, in the shape the plugin persists:
 * the bar only exists beside the code field, and that field only renders once the
 * phase before it has passed.
 */
function savedSession(): unknown {
  const phase = {
    artifact: {},
    attempt: 1,
    passed: true,
    advanced: false,
    unlocked: true,
    step: 0,
    added: 0,
    stepResults: {},
    result: null,
    stuck: [],
    stuckDraft: '',
    read: true
  };
  return { clive: { version: 1, current: 3, tutorialSeen: true, phases: [phase, phase, phase, phase] } };
}

function stubContext(id: string): SolveWindowContext {
  return {
    problem: { id: 'problem-1' },
    practiceSession: { id, extension_data: savedSession() },
    editorState: { code: 'int main(void) { return 0; }' },
    testCaseResults: { results: [], success: false },
    lastTestType: 'run',
    openWindow: () => {},
    closeWindowsExcept: () => {},
    telemetry: { record: () => {}, flush: async () => {} }
  } as unknown as SolveWindowContext;
}

/** The Implement phase's window, where the bar lives. */
function mountImplement(id: string): void {
  mounted = mount(ImplementWindow, { target: document.body, props: { context: stubContext(id) } });
  flushSync();
}

function page(): string {
  return document.body.textContent ?? '';
}

afterEach(() => {
  if (mounted) unmount(mounted);
  mounted = undefined;
  live.mode = 'unavailable';
  live.ready = false;
  live.dead = false;
  live.raw = false;
  document.body.innerHTML = '';
});

describe('the live-checking bar', () => {
  it('says nothing while checking has not started', () => {
    live.mode = 'unavailable';
    mountImplement('live-bar-unavailable');
    expect(page()).not.toContain(NOTE);
    expect(page()).not.toContain(BOX);
  });

  it('says nothing when the switch is off', () => {
    live.mode = 'off';
    mountImplement('live-bar-off');
    expect(page()).not.toContain(NOTE);
    expect(page()).not.toContain(BOX);
  });

  it('promises checking will start, and offers the compiler box, while it loads', () => {
    live.mode = 'on';
    mountImplement('live-bar-loading');
    expect(page()).toContain(NOTE);
    expect(page()).toContain(BOX);
  });

  it('drops the note once clangd is up, keeping the box', () => {
    live.mode = 'on';
    live.ready = true;
    mountImplement('live-bar-ready');
    expect(page()).not.toContain(NOTE);
    expect(page()).toContain(BOX);
  });

  it('goes quiet once live checking has died', () => {
    live.mode = 'on';
    live.ready = true;
    live.dead = true;
    mountImplement('live-bar-dead');
    expect(page()).not.toContain(NOTE);
    expect(page()).not.toContain(BOX);
  });

  it("turns clang's own words on from the box", () => {
    live.mode = 'on';
    live.ready = true;
    mountImplement('live-bar-toggle');
    const input = document.querySelector('input[type="checkbox"]');
    if (!(input instanceof HTMLInputElement)) throw new Error('no checkbox in the live bar');
    input.click();
    flushSync();
    expect(live.raw).toBe(true);
    expect(input.checked).toBe(true);
  });
});
