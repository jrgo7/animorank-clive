/**
 * The one run the page may have going: the same command a person types in the
 * terminal, started with the settings the page asked for.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';

export interface JobState {
  running: boolean;
  /** The run folder's name, under `out/`. */
  id: string | null;
  lines: string[];
  exitCode: number | null;
}

/** What the run prints that is worth showing: its own progress lines, and anything that went wrong. */
const WORTH_SHOWING = [
  /^larper: /,
  /^wrote /,
  /^ran /,
  /^baseline /,
  /^sheets written/,
  /^answers written/,
  /Error/,
  /→/
];

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

export class Job {
  private current: JobState = { running: false, id: null, lines: [], exitCode: null };

  private readonly outRoot: string;
  private readonly cwd: string;
  private readonly command: string[];
  private readonly newId: () => string;
  private readonly keep: RegExp[];

  constructor(
    outRoot: string,
    cwd: string,
    command: string[] = ['npx', 'vitest', 'run', '--config', 'vitest.larper.config.ts'],
    newId: () => string = stamp,
    keep: RegExp[] = WORTH_SHOWING
  ) {
    this.outRoot = outRoot;
    this.cwd = cwd;
    this.command = command;
    this.newId = newId;
    this.keep = keep;
  }

  state(): JobState {
    return { ...this.current, lines: [...this.current.lines] };
  }

  /** Starts the run and returns its id. `settings` are added to this process's environment. */
  start(settings: Record<string, string>, done: () => void = () => {}): string {
    if (this.current.running) throw new Error('A run is already going. Wait for it to finish.');
    const id = this.newId();
    const state: JobState = { running: true, id, lines: [], exitCode: null };
    this.current = state;

    const child = spawn(this.command[0], this.command.slice(1), {
      cwd: this.cwd,
      env: { ...process.env, ...settings, LARPER_OUT: path.join(this.outRoot, id) }
    });
    let pending = '';
    const read = (chunk: Buffer) => {
      pending += chunk.toString('utf8');
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines.map((l) => l.trim())) {
        if (this.keep.some((pattern) => pattern.test(line))) state.lines.push(line.slice(0, 500));
      }
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    const finish = (code: number | null, problem?: string) => {
      if (!state.running) return;
      if (problem) state.lines.push(problem);
      state.running = false;
      state.exitCode = code ?? 1;
      done();
    };
    child.on('error', (error) => finish(1, `Error: the run could not be started: ${error.message}`));
    child.on('close', (code) => {
      read(Buffer.from('\n'));
      finish(code);
    });
    return id;
  }
}
