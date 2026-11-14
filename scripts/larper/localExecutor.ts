import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CodeExecutor } from '$lib/executor';

/** A gcc on this machine standing in for Judge0, so the reference check can run here. */
export const localExecutor = {
  async execute(request: {
    files: { path: string; content: Buffer }[];
    processes: { command: string; args: string[]; stdin?: Buffer }[];
  }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clive-local-'));
    for (const f of request.files) fs.writeFileSync(path.join(dir, f.path), f.content);
    const processOutputs = [];
    for (const p of request.processes) {
      const r = spawnSync(p.command, p.args, { cwd: dir, input: p.stdin, timeout: 5000 });
      processOutputs.push({
        exitCode: r.status ?? undefined,
        stdout: r.stdout ?? Buffer.from(''),
        stderr: r.stderr ?? Buffer.from('')
      });
      if (r.status !== 0) break;
    }
    fs.rmSync(dir, { recursive: true, force: true });
    return { processOutputs };
  }
} as unknown as CodeExecutor;
