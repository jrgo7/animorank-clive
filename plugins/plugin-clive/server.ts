import type { ServerAnimoRankAPI } from '$lib/api/server';
import { ServerPlugin } from '$lib/plugin/serverPlugin';
import { ServerAPIRegistry } from '$lib/server/registry';
import { ServerAPI } from '$lib/server/serverAPI';
import type { FastifyPluginCallback } from 'fastify';

class CLiveAPI extends ServerAPI {
  public async fastifyPlugin(): Promise<FastifyPluginCallback> {
    return (app) => {
      app.get('/', async (_request, reply) => reply.type('text/plain').send('clive'));
    };
  }
}

export default class CLiveServerPlugin extends ServerPlugin {
  public async init(api: ServerAnimoRankAPI): Promise<void> {
    api.serverRegistryProviderRegistrar.getRegistrar(ServerAPIRegistry).register('clive', CLiveAPI);
  }
}
