import type { FastifyPluginCallback } from 'fastify';

export abstract class ServerAPI {
  public abstract fastifyPlugin(): Promise<FastifyPluginCallback>;
}

/**
 * The header the plugin-API bridge names the signed-in user in. Only the bridge
 * sets it: a copy the client sent is dropped before the request reaches a plugin
 * (see `injectPluginApiRequest`), so a plugin can trust what it reads here.
 */
export const PLUGIN_API_USER_HEADER = 'x-animorank-user-id';

/** The id of the user signed in to the page that sent this plugin-API request, or `undefined` for nobody. */
export function requestUserId(request: { headers: Record<string, string | string[] | undefined> }): string | undefined {
  const value = request.headers[PLUGIN_API_USER_HEADER];
  return typeof value === 'string' && value ? value : undefined;
}
