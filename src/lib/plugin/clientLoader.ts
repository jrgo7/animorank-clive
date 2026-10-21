import { ClientAnimoRankAPI } from '$lib/api/client';
import { PLUGIN_ROUTE_PREFIX, type PluginClientDescriptor } from './catalog';
import { ClientPlugin, type PluginPageHook, type PluginPageHookContexts } from './clientPlugin';
import { prebuiltPluginIds } from './prebuiltClientEntries';

/** A plugin client module: its default export is the {@link ClientPlugin} class to instantiate. */
export interface PluginClientModule {
  default?: new () => ClientPlugin;
}

/**
 * Imports a plugin client module from the URL a descriptor names: a file the
 * plugin route serves, or a chunk of the app's client build for a prebuilt
 * plugin (see `prebuiltClientEntries`).
 */
export type PluginModuleImporter = (_path: string) => Promise<PluginClientModule>;

export interface ClientPluginLoaderOptions {
  /** Base URL of the plugin route the loader asks for a plugin's descriptor; defaults to {@link PLUGIN_ROUTE_PREFIX} (same-origin). */
  routeBase?: string;
  /** Module importer override; see {@link PluginModuleImporter}. */
  importModule?: PluginModuleImporter;
  /**
   * The plugins the client knows without asking, by id — the app's own prebuilt
   * set by default. Each one's class can be checked for a page hook without
   * loading it; see {@link ClientPluginLoader.notifyPageHook}.
   */
  prebuiltPlugins?: () => string[];
}

async function importModule(path: string): Promise<PluginClientModule> {
  return (await import(/* @vite-ignore */ path)) as PluginClientModule;
}

/**
 * Loads plugin client entries on demand, one plugin at a time.
 *
 * Nothing is enumerated up front: the plugin to load is named by whatever asks
 * for it — the client asks the server which plugin provides the registry being
 * requested (see `clientPluginFinder`) and hands the loader that plugin id.
 * The id resolves to the descriptor the plugin route serves, which names the
 * files to run: a dynamically loaded plugin's `client.js`, or a prebuilt
 * plugin's entries as the app's build emitted them. The client knows no plugin
 * paths of its own. Only the plugin that was asked for runs — its code, its
 * `init`, and with them the registries it contributes to.
 * Resolution is memoized, so a plugin initializes at most once even under
 * concurrent requests; a failed load is not memoized and can be retried.
 *
 * A page load is the one ask that is not a single plugin id: the loader checks
 * the app's prebuilt plugins for the page's hook and loads those that answer
 * it, and it remembers the page so a plugin loaded later — by a registry miss,
 * say — is told the page it has loaded onto (see {@link notifyPageHook}).
 */
export class ClientPluginLoader {
  private static _instance: ClientPluginLoader | null = null;

  private readonly instances = new Map<string, Promise<ClientPlugin>>();
  /** Descriptors the plugin route served, by plugin id; see {@link servedDescriptor}. */
  private readonly descriptors = new Map<string, Promise<PluginClientDescriptor | undefined>>();
  /** The page the browser is on, so a plugin that loads after it announced is still told. */
  private page: { hook: PluginPageHook; context: unknown; id: number } | null = null;
  private nextPageId = 1;
  /** Pages each plugin has been told about, by plugin id; see {@link deliver}. */
  private readonly told = new Map<string, Set<number>>();
  private readonly routeBase: string;
  private readonly importPlugin: PluginModuleImporter;
  private readonly prebuiltPlugins: () => string[];

  /** The app's loader: one instance, so a plugin initializes at most once per page. */
  public static instance(): ClientPluginLoader {
    ClientPluginLoader._instance ??= new ClientPluginLoader();
    return ClientPluginLoader._instance;
  }

  public constructor(options: ClientPluginLoaderOptions = {}) {
    this.routeBase = options.routeBase ?? PLUGIN_ROUTE_PREFIX;
    this.importPlugin = options.importModule ?? importModule;
    this.prebuiltPlugins = options.prebuiltPlugins ?? prebuiltPluginIds;
  }

  /**
   * The plugin's initialized instance, loading and initializing it on first
   * request. `undefined` when the server serves no client entry for that id:
   * a plugin the app does not have, or one without a client side.
   */
  public async getPlugin(id: string): Promise<ClientPlugin | undefined> {
    const known = this.instances.get(id);
    if (known !== undefined) return known;

    const descriptor = await this.servedDescriptor(id);
    if (!descriptor) return undefined;

    // Re-check before starting: concurrent callers may have started the load
    // while this one awaited the descriptor, and they must share that instance.
    const started = this.instances.get(id);
    if (started !== undefined) return started;

    const loading = this.load(descriptor);
    this.instances.set(id, loading);
    try {
      return await loading;
    } catch (error) {
      // Keep a failed plugin retryable rather than pinned to a rejected promise.
      this.instances.delete(id);
      throw error;
    }
  }

  /**
<<<<<<< HEAD
   * Load and initialize the prebuilt plugins that answer `hook`, without telling
   * them about a page yet.
   *
   * A page whose layout is built from the windows registered so far has to wait
   * for this first: a plugin registers its windows in `init` (see
   * `ClientPlugin.init`), and a page that built its layout before that would
   * find those windows unknown and drop them from it -- so a layout the student
   * arranged would come back without them, every load.
   *
   * The hook itself is still delivered by {@link notifyPageHook}, once the page
   * has the context a hook is called with. A plugin that cannot load is reported
   * and skipped, like everywhere else here: the page does not fail because a
   * plugin did.
   */
  public async preloadPlugins<H extends PluginPageHook>(hook: H): Promise<void> {
    await Promise.all(this.prebuiltPlugins().map((id) => this.loadPageHookPlugin(id, hook)));
=======
   * Loads every plugin the client knows about — the app's prebuilt set —
   * whether or not it answers a page hook.
   *
   * A page that renders whatever a plugin contributes, rather than answering a
   * hook of its own, cannot name the plugins that contribute to it: a prebuilt
   * plugin's registrations happen in the browser, so nothing the server knows
   * lists them. It loads them all instead, and picks the contributions out of
   * the registry afterwards. A plugin that cannot be loaded is reported and
   * skipped; it costs the page its views, never the page.
   */
  public async loadPrebuiltPlugins(): Promise<void> {
    await Promise.all(
      this.prebuiltPlugins().map(async (id) => {
        try {
          await this.getPlugin(id);
        } catch (error) {
          console.error(`Could not load plugin "${id}"`, error);
        }
      })
    );
>>>>>>> 2bd41dd (feat: add replay system and analytics)
  }

  /**
   * Tells the plugins that answer `hook` that the page has loaded, with the
   * page's context, loading them first if they are not loaded already.
   *
   * A plugin answers a page hook by overriding it (see {@link ClientPlugin}).
   * The plugins that can be checked for that without running them are the ones
   * the client knows: each prebuilt plugin's client module is imported and only
   * a class that overrides the hook is loaded for real. A dynamically loaded
   * plugin is named nowhere before it loads, so it answers a page hook when it
   * loads instead — the page it loads onto is remembered here and replayed to it
   * ({@link tellAboutPage}), so a plugin loaded late is told the page it is on.
   *
   * Re-announcing the same page (its context unchanged) does not repeat the
   * hooks; a page announced with a fresh context is a page load, and every
   * answering plugin is told again.
   *
   * Nothing a plugin does here holds up the page: a plugin that cannot load is
   * reported and skipped, and so is one whose hook throws.
   */
  public async notifyPageHook<H extends PluginPageHook>(hook: H, context: PluginPageHookContexts[H]): Promise<void> {
    this.announcePage(hook, context);

    await Promise.all(this.prebuiltPlugins().map((id) => this.loadPageHookPlugin(id, hook)));

    for (const [id, plugin] of await this.loadedPlugins()) {
      await this.deliver(id, plugin, hook, context);
    }
  }

  /**
   * Remember the page the browser is on, so a plugin that loads after this call
   * is still told about it. Only one page is on screen at a time, so the last
   * announcement replaces the one before it.
   */
  private announcePage(hook: PluginPageHook, context: unknown): void {
    const current = this.page;
    if (current && current.hook === hook && current.context === context) return;
    this.page = { hook, context, id: this.nextPageId++ };
    // A page is told once per plugin; the ids of pages nobody is on anymore can never
    // match again, so forget them rather than grow this for the life of the tab.
    this.told.clear();
  }

  /** Tells one plugin about the page it is on, if it answers that page's hook and has not been told. */
  private async tellAboutPage(id: string, plugin: ClientPlugin): Promise<void> {
    const page = this.page;
    if (!page) return;
    await this.deliver(id, plugin, page.hook, page.context);
  }

  /** Tells one plugin about the current page, exactly once: the load path and {@link notifyPageHook} share this. */
  private async deliver(id: string, plugin: ClientPlugin, hook: PluginPageHook, context: unknown): Promise<void> {
    // A plugin that leaves the hook alone is not this page's business, so it is never called.
    if (!answersPageHook(Object.getPrototypeOf(plugin) as ClientPlugin, hook)) return;
    const page = this.page;
    // Only the page on screen is told: an announcement the browser has already left
    // (a newer page replaced it) is dropped rather than replayed to a dead context.
    if (!page || page.hook !== hook || page.context !== context) return;
    const told = this.told.get(id) ?? new Set<number>();
    this.told.set(id, told);
    if (told.has(page.id)) return;
    // Marked before the call, so the other path cannot tell the same page twice.
    told.add(page.id);
    try {
      await (plugin[hook] as (_context: unknown) => void | Promise<void>)(context);
    } catch (error) {
      console.error(`Plugin "${id}" failed its ${hook} hook`, error);
    }
  }

  /** Loads one known plugin when its class overrides `hook`; a plugin that cannot be loaded is skipped. */
  private async loadPageHookPlugin(id: string, hook: PluginPageHook): Promise<void> {
    try {
      const Plugin = await this.pluginClass(id);
      if (Plugin && answersPageHook(Plugin.prototype, hook)) {
        await this.getPlugin(id);
      }
    } catch (error) {
      console.error(`Could not load plugin "${id}" for ${hook}`, error);
    }
  }

  /** Every plugin this loader has initialized, by id. A plugin that failed to
   *  load is skipped: it was reported where its load was requested. */
  private async loadedPlugins(): Promise<[string, ClientPlugin][]> {
    const loaded: [string, ClientPlugin][] = [];
    for (const [id, plugin] of this.instances) {
      try {
        loaded.push([id, await plugin]);
      } catch {
        // Reported where the load was requested (`getPlugin`); one plugin that
        // cannot load must not stop the others answering a page hook.
      }
    }
    return loaded;
  }

  /** The class a plugin's client module default-exports, imported but neither instantiated nor initialized. */
  private async pluginClass(id: string): Promise<(new () => ClientPlugin) | undefined> {
    const descriptor = await this.servedDescriptor(id);
    return descriptor ? await this.importPluginClass(descriptor) : undefined;
  }

  /** The descriptor the plugin route serves for one plugin, asked for once per id. */
  private servedDescriptor(id: string): Promise<PluginClientDescriptor | undefined> {
    const known = this.descriptors.get(id);
    if (known !== undefined) return known;

    const request = this.fetchDescriptor(id).catch((error: unknown) => {
      // A failed request must not poison the loader; the next call retries.
      this.descriptors.delete(id);
      throw error;
    });
    this.descriptors.set(id, request);
    return request;
  }

  private async fetchDescriptor(id: string): Promise<PluginClientDescriptor | undefined> {
    const response = await fetch(`${this.routeBase}/${id}`);
    // A plugin the server serves no client entry for is nothing to load, which
    // is not an error: the route answers 404 for it.
    if (response.status === 404) return undefined;
    if (!response.ok) {
      throw new Error(`Failed to load plugin "${id}" (${response.status} ${response.statusText})`);
    }
    return (await response.json()) as PluginClientDescriptor;
  }

  private async load(descriptor: PluginClientDescriptor): Promise<ClientPlugin> {
    const Plugin = await this.importPluginClass(descriptor);

    // Everything the plugin ships is served under its own folder of the route;
    // the plugin reaches its files through the API (see `AnimoRankAPI.import`).
    const filesUrl = `${this.routeBase}/${descriptor.id}/`;
    const plugin = new Plugin();
    await plugin.init(new ClientAnimoRankAPI(descriptor.id, filesUrl));
    // The plugin now exists on whatever page the browser is on: tell it, so a plugin
    // loaded after the page announced itself (a registry miss, say) is not left silent.
    await this.tellAboutPage(descriptor.id, plugin);
    return plugin;
  }

  /** Imports the module the descriptor names and returns the plugin class it default-exports. */
  private async importPluginClass(descriptor: PluginClientDescriptor): Promise<new () => ClientPlugin> {
    // The shared entry runs before the per-side one, exactly as on the server.
    if (descriptor.globalUrl) {
      await this.importPlugin(descriptor.globalUrl);
    }

    const module = await this.importPlugin(descriptor.clientUrl);
    if (!module.default) {
      throw new Error(`Plugin "${descriptor.id}" has no default export in ${descriptor.clientUrl}`);
    }
    return module.default;
  }
}

/**
 * Whether a plugin class replaces `hook` with an implementation of its own:
 * what decides whether a page is the plugin's business at all. A plugin that
 * leaves the base method alone is not loaded for the page and never called.
 */
function answersPageHook(prototype: ClientPlugin, hook: PluginPageHook): boolean {
  const method: unknown = prototype[hook];
  return typeof method === 'function' && method !== ClientPlugin.prototype[hook];
}
