/**
 * Running a C program the way the app does: one compile and one run per stdin,
 * through the executor the platform is configured with (Judge0).
 *
 * Shared by the reference check (the problem's own solution) and the public test
 * run the stuck ask is grounded in, so both compile with the same flags as the
 * app's own C test case.
 */
import { CodeExecutor } from '$lib/executor';
import { ServerRegistryProvider } from '$lib/registry/server';

export interface ProgramRun {
  compiled: boolean;
  compileError: string;
  /** Absent when the run was stopped (a timeout collapses to one entry with no exit code). */
  exitCode?: number;
  stdout: string;
}

/** The executor the app runs student C on; injected in tests. */
export async function defaultExecutor(): Promise<CodeExecutor> {
  return ServerRegistryProvider.instance().getService(CodeExecutor);
}

/** Compile `code` and run it once on `stdin`. */
export async function runProgram(executor: CodeExecutor, code: string, stdin: string): Promise<ProgramRun> {
  const result = await executor.execute({
    files: [{ path: 'main.c', content: Buffer.from(code, 'utf8') }],
    processes: [
      // Same flags as the app's own C stdio test case.
      { command: 'gcc', args: ['-Werror', '-Wall', '-o', 'program', 'main.c', '-lm', '-lpthread'] },
      { command: './program', args: [], stdin: Buffer.from(stdin, 'utf8') }
    ]
  });
  const compile = result.processOutputs[0];
  const run = result.processOutputs[1];
  return {
    compiled: compile?.exitCode === 0,
    compileError: compile?.exitCode !== 0 ? (compile?.stderr?.toString('utf8') ?? 'compilation failed') : '',
    exitCode: run?.exitCode,
    stdout: run?.stdout?.toString('utf8') ?? ''
  };
}

/** Trailing whitespace per line, then trailing newlines — `grade.normalise`. */
export function normaliseOutput(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n+$/, '');
}
