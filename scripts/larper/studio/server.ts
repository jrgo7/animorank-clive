/**
 * The larper's page: `npm run larper:studio`, then open the address it prints.
 *
 * A local tool for the researcher. It listens on this machine only, starts the same
 * command a terminal run uses, and reads the same files that run writes.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { parse } from 'yaml';
import { PHASES } from '../types';
import { handle, type Context } from './api';
import { Job } from './job';
import type { StudioCategories } from './runs';

const root = path.join(process.cwd(), 'scripts/larper');
const port = Number.parseInt(process.env.LARPER_STUDIO_PORT ?? '8766', 10);
const job = new Job(path.join(root, 'out'), process.cwd());

const context: Context = {
  root,
  port,
  // Read on every request, so an edit to the categories shows without a restart.
  categories: () => {
    const doc = (parse(fs.readFileSync(path.join(root, 'categories.yaml'), 'utf8')) ?? {}) as Record<
      string,
      { id: string; name: string }[] | undefined
    >;
    return Object.fromEntries(
      PHASES.map((phase) => [phase, (doc[phase] ?? []).map((c) => ({ id: String(c.id), name: String(c.name) }))])
    ) as StudioCategories;
  },
  page: () => fs.readFileSync(path.join(root, 'studio/page.html'), 'utf8'),
  job: { state: () => job.state(), start: (settings) => job.start(settings) }
};

const server = http.createServer((request, response) => {
  const chunks: Buffer[] = [];
  let size = 0;
  request.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > 100_000) request.destroy();
    else chunks.push(chunk);
  });
  request.on('end', () => {
    const result = handle(
      {
        method: request.method ?? 'GET',
        url: request.url ?? '/',
        host: request.headers.host ?? '',
        origin: request.headers.origin,
        contentType: request.headers['content-type'] ?? '',
        body: Buffer.concat(chunks).toString('utf8')
      },
      context
    );
    response.writeHead(result.status, {
      'content-type': result.type,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...(result.download ? { 'content-disposition': `attachment; filename="${result.download}"` } : {})
    });
    response.end(result.body);
  });
});

server.on('error', (error: NodeJS.ErrnoException) => {
  console.error(
    error.code === 'EADDRINUSE'
      ? `Port ${port} is in use. Is the page already open? Otherwise set LARPER_STUDIO_PORT to another port.`
      : error.message
  );
  process.exit(1);
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Larper is at http://127.0.0.1:${port}  (Ctrl+C to stop)`);
});
