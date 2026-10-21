import type { Handle, HandleServerError, ServerInit } from '@sveltejs/kit';
import { building } from '$app/environment';
import { handle as authHandle } from '$lib/auth';
import { Logger } from '$lib/logging/logger';
import { ServerRegistryProvider } from '$lib/registry/server';
import { ServerPluginService } from '$lib/plugin/serverPluginService';
import { Server, type ServerApp } from '$lib/server';
import { injectPluginApiRequest, isPluginApiPath } from '$lib/server/pluginApiRequest';
import { clangdPresent } from '$lib/clangd/assets.server';
import { ISOLATION_HEADERS, isCrossOriginIsolatedPage } from '$lib/crossOriginIsolation';
import { errorMessage } from '$lib/utils/errorMessage';

/**
 * Load every plugin when the server starts, so no request waits on plugin
 * loading. The browser loads plugins lazily instead, when a lookup misses a
 * registry or one of its items (see `src/lib/registry/clientPlugins.ts`).
 */
export const init: ServerInit = async () => {
  // This hook runs while a build prerenders too; plugins are runtime state, and
  // the configured plugin folder need not exist at build time.
  if (building) return;

  try {
    await ServerPluginService.instance().getLoader();
  } catch (error) {
    // A broken plugin setup must not keep the server from starting: the service
    // reports the failure again to whoever needs plugins.
    const logger = await ServerRegistryProvider.instance().getService(Logger, 'webserver');
    logger.error(`Failed to load plugins: ${errorMessage(error)}`);
  }

  // The app mounts the APIs a plugin registers while loading (see
  // `Server.prepareApp`), so it is prepared only now, with every plugin already
  // loaded, and each plugin's routes are part of it.
  app = await new Server().prepareApp();

  // Live C diagnostics in the CLive plugin run on clangd, which is too big for
  // git and fetched once per machine. Say so once, here, rather than let an
  // operator find out from a student whose editor stayed quiet.
  if (!clangdPresent()) {
    const logger = await ServerRegistryProvider.instance().getService(Logger, 'webserver');
    logger.info(
      'clangd is not vendored, so the CLive plugin will not mark C as the student types. Run: npm run scripts:fetchClangd'
    );
  }
};

/**
 * The Fastify app the plugin APIs are mounted on, prepared by `init` once the
 * plugins have loaded. A build never prepares one: plugins are runtime state.
 */
let app: ServerApp | undefined;

export const handle: Handle = async ({ event, resolve }) => {
  const registryProvider = ServerRegistryProvider.instance();
  const logger = await registryProvider.getService(Logger, 'webserver');

  logger.debug(`${event.request.method} ${event.url.pathname}`);

  // A plugin API request belongs to the Fastify app, never to a route of this
  // app, so it is injected before anything resolves it here — resolving a path
  // that is no route of the app throws rather than answering 404. It still goes
  // through the auth handle first, so the plugin is told who is signed in the
  // same way every route of the app finds out.
  if (isPluginApiPath(event.url.pathname)) {
    if (app === undefined) return new Response('Not Found', { status: 404 });
    const pluginApp = app;
    return authHandle({
      event,
      resolve: async (authed) => injectPluginApiRequest(pluginApp, authed, (await authed.locals.auth())?.user?.id)
    });
  }

  const response = await authHandle({ event, resolve });

  // Live C diagnostics run clangd's threads, and a browser only gives a document
  // SharedArrayBuffer when it is cross-origin isolated. Only the solve page runs
  // clangd, so only the solve page carries these; every other page of the app is
  // served exactly as before.
  if (isCrossOriginIsolatedPage(event.url.pathname)) {
    for (const [name, value] of Object.entries(ISOLATION_HEADERS)) response.headers.set(name, value);
  }

  return response;
};

export const handleError: HandleServerError = async ({ error }) => {
  // Reporting a crash must not itself be able to crash: the logger is reached
  // through the registry provider, and anything that goes wrong on the way —
  // a registry that is missing, a logger that throws while writing — falls back
  // to the console, which needs nothing of the app to work.
  try {
    const registryProvider = ServerRegistryProvider.instance();
    const logger = await registryProvider.getService(Logger, 'webserver');

    logger.error('CRASH ERROR: ' + crashDetail(error));
  } catch (loggingError) {
    console.error('CRASH ERROR (could not be logged):', error, loggingError);
  }

  return { message: 'Internal Error' };
};

/** A crash's detail, built without assuming anything about what was thrown. */
function crashDetail(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  // Non-Error throws can be circular or BigInt-containing objects that
  // JSON.stringify itself crashes on — never let the error handler throw.
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
