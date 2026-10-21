import type { ClientAnimoRankAPI } from '$lib/api/client';
import { ClientPlugin } from '$lib/plugin/clientPlugin';
import type { SessionLogsWindowRegistry } from '../../../routes/instructor/analytics/session-logs/windowRegistry';
import type { SessionLogsViewContext } from '../../../routes/instructor/analytics/session-logs/context.svelte';
import { ReplayWindow } from './Replay.window';

/** The key this plugin's view is registered under, in the plugin's own namespace. */
const VIEW = 'replay';

export default class SessionReplayClientPlugin extends ClientPlugin {
  private viewKey = VIEW;

  public async init(api: ClientAnimoRankAPI): Promise<void> {
    const registrar =
      await api.clientRegistryProviderRegistrar.getRegistrarById<SessionLogsWindowRegistry>('window.session_logs');
    this.viewKey = `${registrar.id}:${VIEW}`;
    registrar.register(VIEW, ReplayWindow);
  }

  public async onSessionLogsLoad(context: SessionLogsViewContext): Promise<void> {
    // A selected session is worth replaying whatever it contains, so this view
    // comes forward -- unless it is a CLive session, where the plugin's own
    // event view is the more useful default. Both stay one tab away.
    if (context.logs.length > 0 && !context.logs.some((entry) => entry.type.startsWith('CLIVE_'))) {
      await context.openView(this.viewKey);
    }
  }
}
