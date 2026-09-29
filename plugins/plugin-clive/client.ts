import type { ClientAnimoRankAPI } from '$lib/api/client';
import { ClientPlugin } from '$lib/plugin/clientPlugin';
import type { SolveWindowContext } from '../../src/routes/problem/[problem_id]/[session_id]/context.svelte';
import { SolveWindowRegistry } from '../../src/routes/problem/[problem_id]/[session_id]/windowRegistry';
import { ProblemWindow } from './windows/ProblemWindow.window';

export default class CLivePlugin extends ClientPlugin {
  public async init(api: ClientAnimoRankAPI): Promise<void> {
    api.clientRegistryProviderRegistrar.getRegistrar(SolveWindowRegistry).register('problem', ProblemWindow);
  }

  public onSolvePageLoad(context: SolveWindowContext): void | Promise<void> {
    context.openWindow('clive:problem');
  }
}
