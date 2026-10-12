import type { ServerAnimoRankAPI } from '$lib/api/server';
import { ServerPlugin } from '$lib/plugin/serverPlugin';
import { ServerAPIRegistry } from '$lib/server/registry';
import CLiveAPI from './server/routes';

export default class CLiveServerPlugin extends ServerPlugin {
  public async init(api: ServerAnimoRankAPI): Promise<void> {
    api.serverRegistryProviderRegistrar.getRegistrar(ServerAPIRegistry).register('clive', CLiveAPI);
  }
}
